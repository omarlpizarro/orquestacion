#!/usr/bin/env bash
# Despliegue en el server de demo. Se corre en el server, dentro del clon del repo:
#
#   scripts/deploy.sh             # pull, build, migraciones, reinicio
#   scripts/deploy.sh --no-pull   # despliega la main local, que ya debe coincidir con origin/main
#
# Exige estar en main, sincronizado con origin/main y con el árbol limpio.
#
# Orden fijo: pull -> build -> migraciones -> reinicio. Las migraciones son un
# paso explícito y nunca corren al arrancar el contenedor de la API
# (CLAUDE.md §6: despliegues separados). Si un paso falla, `set -e` corta ahí:
# una migración rota deja corriendo la versión anterior de la API.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"

pull=true
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=false ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> [%s] %s\n' "$1" "$2"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- Chequeos previos: antes de tocar nada -----------------------------------

[ -f "$env_file" ] || die "Falta $env_file. Copiá infra/docker/server.env.example y completalo."
if grep -q 'CHANGE_ME' "$env_file"; then
  die "$env_file todavía tiene valores CHANGE_ME. Generá cada secreto con: openssl rand -hex 24"
fi

# Un árbol sucio construiría una imagen que no corresponde al commit que
# /health va a declarar.
if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]; then
  die "El árbol de trabajo tiene cambios sin commitear; el commit que reportaría /health sería mentira."
fi

# El server solo corre lo que está mergeado a main. Sin excepciones ni flag
# para saltearlo: desplegar una rama sin revisar fue la excepción que sirvió
# para arrancar este mecanismo, no una opción permanente.
branch="$(git -C "$repo_root" branch --show-current)"
[ "$branch" = "main" ] || die "Solo se despliega desde main (estás en '${branch:-HEAD desacoplado}')."
git -C "$repo_root" fetch --quiet origin main
if $pull; then
  # Con pull, alcanza con que main local no se haya adelantado ni divergido.
  git -C "$repo_root" merge-base --is-ancestor HEAD origin/main \
    || die "main local tiene commits que no están en origin/main."
else
  [ "$(git -C "$repo_root" rev-parse HEAD)" = "$(git -C "$repo_root" rev-parse origin/main)" ] \
    || die "main local no coincide con origin/main. Corré sin --no-pull o actualizá a mano."
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

if $pull; then
  step 1/5 "git pull --ff-only"
  git -C "$repo_root" pull --ff-only
else
  step 1/5 "git pull (omitido por --no-pull)"
fi

commit="$(git -C "$repo_root" rev-parse HEAD)"
echo "Commit a desplegar: $commit"

step 2/5 "build de la imagen"
"$compose" build api

# Postgres tiene que estar arriba para migrar. Es un prerrequisito, no el
# reinicio: `up -d` no toca un contenedor cuya configuración no cambió.
step 3/5 "Postgres arriba (prerrequisito de las migraciones)"
"$compose" up -d --wait postgres

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

echo
echo "Desplegado $commit en http://127.0.0.1:$api_port (BETTER_AUTH_URL=$BETTER_AUTH_URL)."
