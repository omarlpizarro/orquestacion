#!/usr/bin/env bash
# Despliegue en el server de demo. Se corre en el server, dentro del clon del repo:
#
#   scripts/deploy.sh                 # pull, build, migraciones, reinicio (desde main)
#   scripts/deploy.sh --no-pull       # despliega HEAD tal cual está (debe ser ancestro de origin/main)
#   scripts/deploy.sh --to <commit>   # vuelta atrás: checkout de ese commit y despliegue
#
# El server solo corre commits que ya están en origin/main: la regla es que
# HEAD sea ancestro de origin/main (`git merge-base --is-ancestor`), lo que
# incluye a origin/main misma y a cualquier versión anterior. Exige además el
# árbol limpio. El despliegue "hacia adelante" se hace desde la rama main.
#
# Por qué existe --to: hacer `git checkout <commit>` a mano y correr después
# `scripts/deploy.sh` ejecutaría el deploy.sh *de ese commit viejo*, que puede
# tener reglas más estrictas y negarse. Con --to corre siempre la versión
# actual del script, que es quien hace el checkout.
#
# Después del pull, el script se relanza a sí mismo (`exec bash ... --no-pull`)
# para correr la versión nueva: Bash sigue ejecutando la que ya tenía cargada, y
# sin esto cualquier cambio a este archivo regiría recién el deploy siguiente.
# Se relanza con `bash` explícito, no ejecutando el archivo: así no depende del
# bit de ejecución ni del shebang de la versión que trajo el pull.
# Consecuencia: los chequeos previos corren dos veces, la segunda con las reglas
# nuevas. Con `--to` no se relanza a propósito: ahí se quiere la versión actual,
# no la del commit destino. La primera vez que un deploy trae este mecanismo
# todavía corre la versión vieja, sin relanzamiento; rige desde el siguiente.
#
# Orden fijo: pull -> build -> migraciones -> reinicio. Las migraciones son un
# paso explícito y nunca corren al arrancar el contenedor de la API
# (CLAUDE.md §6: despliegues separados). Si un paso falla, `set -e` corta ahí:
# una migración rota deja corriendo la versión anterior de la API.
#
# Las migraciones nunca se revierten, ni siquiera en una vuelta atrás: el
# código viejo corre contra el esquema nuevo. Eso es seguro solo porque
# CLAUDE.md §6 exige que las migraciones únicamente agreguen y no rompan lo
# que usa el código anterior.
#
# Al terminar bien, conserva las 3 imágenes más recientes de la API (y la
# desplegada, si es más vieja) y borra el resto: son los destinos de una
# vuelta atrás, que no reconstruye si la imagen sigue ahí.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"
image_repo="orquestacion-api"
keep_images=3

pull=true
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) pull=false ;;
    --to)
      [ $# -ge 2 ] || { echo "--to necesita un commit." >&2; exit 2; }
      target="$2"; pull=false; shift ;;
    *) echo "Argumento desconocido: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n==> [%s] %s\n' "$1" "$2"; }
die() { echo "ERROR: $*" >&2; exit 1; }
git_repo() { git -C "$repo_root" "$@"; }

# --- Chequeos previos: antes de tocar nada -----------------------------------

[ -f "$env_file" ] || die "Falta $env_file. Copiá infra/docker/server.env.example y completalo."
if grep -q 'CHANGE_ME' "$env_file"; then
  die "$env_file todavía tiene valores CHANGE_ME. Generá cada secreto con: openssl rand -hex 24"
fi

# Un árbol sucio construiría una imagen que no corresponde al commit que
# /health va a declarar.
if [ -n "$(git_repo status --porcelain --untracked-files=no)" ]; then
  die "El árbol de trabajo tiene cambios sin commitear; el commit que reportaría /health sería mentira."
fi

git_repo fetch --quiet origin main

if [ -n "$target" ]; then
  target_commit="$(git_repo rev-parse --verify --quiet "$target^{commit}")" \
    || die "'$target' no es un commit que este clon conozca."
  git_repo merge-base --is-ancestor "$target_commit" origin/main \
    || die "$target_commit no es ancestro de origin/main: solo se despliega lo que está mergeado."
  # Un commit anterior al mecanismo de despliegue no tiene Dockerfile ni compose.
  git_repo cat-file -e "$target_commit:infra/docker/compose.server.yml" 2>/dev/null \
    || die "$target_commit es anterior al mecanismo de despliegue (no tiene infra/docker/compose.server.yml)."
elif $pull; then
  # Hacia adelante: hace falta una rama para el pull, y tiene que ser main.
  branch="$(git_repo branch --show-current)"
  [ "$branch" = "main" ] \
    || die "El pull solo se hace desde main (estás en '${branch:-HEAD desacoplado}'). Para volver adelante: git checkout main. Para una vuelta atrás: --to <commit>."
  # Alcanza con que main local no se haya adelantado ni divergido.
  git_repo merge-base --is-ancestor HEAD origin/main \
    || die "main local tiene commits que no están en origin/main."
else
  git_repo merge-base --is-ancestor HEAD origin/main \
    || die "HEAD no es ancestro de origin/main: solo se despliega lo que está mergeado."
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
api_port="${API_HOST_PORT:-18020}"

# Servidor compartido: si el puerto ya lo usa algo, tiene que ser nuestra propia API.
if ss -ltnH "sport = :$api_port" | grep -q .; then
  if [ -z "$("$compose" ps -q api 2>/dev/null)" ]; then
    die "El puerto $api_port del host ya está en uso por otro proceso. Cambiá API_HOST_PORT en $env_file."
  fi
fi

case "${BETTER_AUTH_URL:-}" in
  http://*) echo "Aviso: BETTER_AUTH_URL es http://. Las cookies de sesión saldrán sin Secure (solo válido para la prueba sin TLS)." ;;
esac

# --- Pasos -------------------------------------------------------------------

if [ -n "$target" ]; then
  step 1/5 "checkout de $target_commit (vuelta atrás)"
  git_repo checkout --quiet --detach "$target_commit"
elif $pull; then
  step 1/5 "git pull --ff-only"
  git_repo pull --ff-only
  # Bash sigue ejecutando la versión de este script que ya cargó: si el pull
  # la cambió, los cambios regirían recién en el despliegue siguiente. Se
  # relanza con lo que quedó en disco para que un deploy siempre corra la
  # versión que está en main. DEPLOY_REEXEC corta el bucle: el proceso
  # relanzado no vuelve a relanzarse.
  if [ -z "${DEPLOY_REEXEC:-}" ]; then
    echo "Relanzando deploy.sh con la versión de $(git_repo rev-parse --short HEAD)."
    DEPLOY_REEXEC=1 exec bash "$repo_root/scripts/deploy.sh" --no-pull
  fi
elif [ -n "${DEPLOY_REEXEC:-}" ]; then
  step 1/5 "git pull (hecho antes del relanzamiento)"
else
  step 1/5 "git pull (omitido por --no-pull)"
fi

commit="$(git_repo rev-parse HEAD)"
echo "Commit a desplegar: $commit"
behind="$(git_repo rev-list --count "$commit..origin/main")"
if [ "$behind" -gt 0 ]; then
  echo "Aviso: VUELTA ATRÁS. Ese commit está $behind commit(s) detrás de origin/main."
fi

image="$image_repo:$commit"
step 2/5 "imagen de la API"
if docker image inspect "$image" >/dev/null 2>&1; then
  # Solo se construye con el árbol limpio (chequeo de arriba), así que una
  # imagen con este tag corresponde exactamente a este commit.
  echo "$image ya existe: se reutiliza, sin reconstruir."
else
  "$compose" build api
fi

# Postgres tiene que estar arriba para migrar. Es un prerrequisito, no el
# reinicio: `up -d` no toca un contenedor cuya configuración no cambió.
step 3/5 "Postgres arriba (prerrequisito de las migraciones)"
"$compose" up -d --wait postgres

# El migrador de Drizzle solo aplica lo posterior a la última migración
# registrada, así que con un commit viejo no hace nada. Pero el código viejo
# va a correr contra un esquema que no conoce: que se note.
known="$(grep -c '"tag"' "$repo_root/packages/db/migrations/meta/_journal.json" || true)"
applied="$("$compose" exec -T postgres psql -U postgres -d orquestacion -Atc \
  'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo 0)"
if [ "$applied" -gt "$known" ]; then
  echo "Aviso: la base tiene $applied migraciones aplicadas y este commit conoce $known."
  echo "       El código de este commit va a correr contra un esquema más nuevo; es seguro solo si"
  echo "       esas migraciones son compatibles hacia atrás (CLAUDE.md §6)."
fi

step 4/5 "migraciones (como app_owner, contenedor efímero)"
"$compose" run --rm migrate

step 5/5 "reinicio de la API"
"$compose" up -d --wait api

# --- Verificación ------------------------------------------------------------

health="$(curl -fsS "http://127.0.0.1:$api_port/health")" || die "/health no respondió."
deployed="$(printf '%s' "$health" | grep -o '"commit":"[^"]*"' | cut -d'"' -f4)"
if [ "$deployed" != "$commit" ]; then
  die "/health reporta commit '$deployed' pero se desplegó '$commit'."
fi

# --- Limpieza de imágenes ----------------------------------------------------
# Solo después de un despliegue verificado: si fallara, las imágenes anteriores
# son justamente las que hacen falta para volver atrás. Se toca únicamente el
# repositorio $image_repo (exacto): en este server hay imágenes de otros
# proyectos, y no se hace `image prune` ni `builder prune` porque son globales.
# La imagen desplegada se conserva siempre, aunque sea vieja (vuelta atrás).
echo
echo "Imágenes de $image_repo: se conservan las $keep_images más recientes y la desplegada."
rank=0
while IFS= read -r tag; do
  [ -n "$tag" ] && [ "$tag" != "<none>" ] || continue
  rank=$((rank + 1))
  if [ "$rank" -le "$keep_images" ] || [ "$tag" = "$commit" ]; then
    continue
  fi
  docker rmi "$image_repo:$tag" >/dev/null 2>&1 \
    && echo "  borrada  $image_repo:$tag" \
    || echo "  no se pudo borrar $image_repo:$tag (¿en uso?), se deja."
done < <(docker image ls "$image_repo" --format '{{.CreatedAt}}|{{.Tag}}' | sort -r | cut -d'|' -f2)

echo
echo "Desplegado $commit en http://127.0.0.1:$api_port (BETTER_AUTH_URL=$BETTER_AUTH_URL)."
