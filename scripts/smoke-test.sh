#!/usr/bin/env bash
# Prueba de humo del despliegue. Se corre en el server, dentro del clon del repo:
#
#   scripts/smoke-test.sh
#
# Valida el mecanismo de despliegue, no funcionalidad de negocio:
#   1. /health responde, conecta como app_login y devuelve el commit desplegado.
#   2. Postgres no tiene ningún puerto publicado hacia el host.
#   3. Cuenta de humo fija: si existe inicia sesión, si no la crea. Las cookies
#      salen como corresponde al esquema de BETTER_AUTH_URL, y la sesión
#      PERSISTE al volver a mandar la cookie (si las cookies salieran Secure
#      sobre http, el navegador no las devolvería y este paso fallaría).
#   4. Organización de humo fija: si existe la reutiliza, si no la crea. El
#      hook de ADR-013 tiene que haberle dejado el sitio por defecto.
#   5. Un script operativo (ensure-default-sites) corre dentro del contenedor.
#
# Es idempotente: siempre usa el mismo usuario (smoke@orquestacion.test) y la
# misma organización (slug `smoke`), así que correrla N veces no acumula
# filas. El password de la cuenta vive en infra/docker/.env como
# SMOKE_PASSWORD; si falta, la primera corrida lo genera y lo agrega ahí.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"

smoke_email="smoke@orquestacion.test"
smoke_org_slug="smoke"

[ -f "$env_file" ] || { echo "Falta $env_file" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [ -z "${SMOKE_PASSWORD:-}" ]; then
  SMOKE_PASSWORD="$(openssl rand -hex 16)"
  printf '\n# Cuenta de humo (scripts/smoke-test.sh). Generado en la primera corrida.\nSMOKE_PASSWORD=%s\n' \
    "$SMOKE_PASSWORD" >> "$env_file"
  echo "Aviso: SMOKE_PASSWORD no estaba en $env_file; se generó y se agregó."
fi

base="http://127.0.0.1:${API_HOST_PORT:-18020}"
expected_commit="$(git -C "$repo_root" rev-parse HEAD)"
work_dir="$(mktemp -d)"
jar="$work_dir/cookies"
trap 'rm -rf "$work_dir"' EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; exit 1; }
json_field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# POST JSON con Origin (Better Auth lo exige en pedidos con cookies). Deja
# los headers en $work_dir/headers, el cuerpo en $work_dir/body y devuelve
# el código HTTP.
post_json() {
  curl -sS -o "$work_dir/body" -D "$work_dir/headers" -w '%{http_code}' \
    -b "$jar" -c "$jar" -X POST "$base$1" \
    -H 'content-type: application/json' -H "Origin: $BETTER_AUTH_URL" -d "$2"
}

echo "1. /health"
health="$(curl -fsS "$base/health")" || fail "/health no respondió"
[ "$(printf '%s' "$health" | json_field connectedAs)" = "app_login" ] \
  || fail "la API no conecta como app_login: $health"
pass "conecta como app_login"
[ "$(printf '%s' "$health" | json_field commit)" = "$expected_commit" ] \
  || fail "el commit de /health no es $expected_commit: $health"
pass "commit desplegado = $expected_commit"

echo "2. Postgres sin puerto publicado"
pg_container="$("$compose" ps -q postgres)"
[ -n "$pg_container" ] || fail "no hay contenedor de postgres"
if docker inspect -f '{{json .NetworkSettings.Ports}}' "$pg_container" | grep -q HostPort; then
  fail "Postgres publica un puerto hacia el host"
fi
pass "ningún HostPort en el contenedor de Postgres"

echo "3. Cuenta de humo y persistencia de sesión"
credentials="{\"email\":\"$smoke_email\",\"password\":\"$SMOKE_PASSWORD\"}"
status="$(post_json /api/auth/sign-in/email "$credentials")"
if [ "$status" = "200" ]; then
  pass "la cuenta $smoke_email ya existía: sesión iniciada"
else
  status="$(post_json /api/auth/sign-up/email \
    "{\"email\":\"$smoke_email\",\"password\":\"$SMOKE_PASSWORD\",\"name\":\"Smoke\"}")"
  [ "$status" = "200" ] \
    || fail "no se pudo iniciar sesión ni crear $smoke_email (HTTP $status): $(cat "$work_dir/body")\n     Si la cuenta existe con otro password, revisá SMOKE_PASSWORD en $env_file."
  pass "la cuenta $smoke_email no existía: creada"
fi

cookie_lines="$(grep -i '^set-cookie:' "$work_dir/headers" || true)"
[ -n "$cookie_lines" ] || fail "la autenticación no devolvió ninguna cookie"
case "$BETTER_AUTH_URL" in
  https://*) printf '%s' "$cookie_lines" | grep -qi ';[[:space:]]*secure' \
               || fail "BETTER_AUTH_URL es https:// pero la cookie salió sin Secure" ;;
  *)         if printf '%s' "$cookie_lines" | grep -qi ';[[:space:]]*secure'; then
               fail "BETTER_AUTH_URL es http:// y la cookie salió con Secure: el navegador no la devolvería"
             fi ;;
esac
pass "atributo Secure coherente con $BETTER_AUTH_URL"

session="$(curl -fsS -b "$jar" "$base/api/auth/get-session")" || fail "get-session falló"
printf '%s' "$session" | grep -q "$smoke_email" \
  || fail "la sesión no persistió al reenviar la cookie: $session"
pass "la sesión persiste"

echo "4. Organización de humo (hook de sitio por defecto)"
orgs="$(curl -fsS -b "$jar" "$base/api/auth/organization/list")" \
  || fail "no se pudo listar las organizaciones"
if printf '%s' "$orgs" | grep -q "\"slug\":\"$smoke_org_slug\""; then
  # La cuenta de humo solo pertenece a esta organización, así que el primer
  # id del listado es el suyo.
  org_id="$(printf '%s' "$orgs" | json_field id)"
  pass "la organización '$smoke_org_slug' ya existía"
else
  status="$(post_json /api/auth/organization/create \
    "{\"name\":\"Smoke\",\"slug\":\"$smoke_org_slug\"}")"
  [ "$status" = "200" ] \
    || fail "no se pudo crear la organización (HTTP $status): $(cat "$work_dir/body")"
  org_id="$(json_field id < "$work_dir/body")"
  pass "la organización '$smoke_org_slug' no existía: creada"
fi
[ -n "$org_id" ] || fail "no se pudo leer el id de la organización"
# Como superusuario del contenedor de Postgres (socket local): RLS no aplica.
sites="$("$compose" exec -T postgres psql -U postgres -d orquestacion -Atc \
  "select count(*) from site where organization_id = '$org_id'")"
[ "$sites" -ge 1 ] || fail "la organización $org_id no tiene sitio por defecto"
pass "la organización $org_id tiene $sites sitio(s)"

echo "5. Script operativo dentro del contenedor (ensure-default-sites)"
output="$("$compose" run --rm --no-deps api node dist/src/scripts/ensure-default-sites.js)" \
  || fail "ensure-default-sites terminó con error:\n$output"
printf '     %s\n' "$output"
printf '%s' "$output" | grep -q 'Fallidas: 0' || fail "ensure-default-sites reportó fallidas"
pass "ensure-default-sites corrió sin fallidas"

echo
echo "Prueba de humo OK."
