#!/usr/bin/env bash
# Prueba de humo del despliegue. Se corre en el server, dentro del clon del repo:
#
#   scripts/smoke-test.sh
#
# Valida el mecanismo de despliegue, no funcionalidad de negocio:
#   1. /health responde, conecta como app_login y devuelve el commit desplegado.
#   2. Postgres no tiene ningún puerto publicado hacia el host.
#   3. Alta de usuario: las cookies salen como corresponde al esquema de
#      BETTER_AUTH_URL, y la sesión PERSISTE al volver a mandar la cookie
#      (si las cookies salieran Secure sobre http, el navegador no las
#      devolvería y este paso fallaría).
#   4. Alta de organización: el hook de ADR-013 crea el sitio por defecto.
#   5. Un script operativo (ensure-default-sites) corre dentro del contenedor.
#
# Deja un usuario y una organización `smoke-*` en la base de demo (no se
# borran: regla dura 9, nada se borra físicamente).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"

[ -f "$env_file" ] || { echo "Falta $env_file" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

base="http://127.0.0.1:${API_HOST_PORT:-18020}"
expected_commit="$(git -C "$repo_root" rev-parse HEAD)"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; exit 1; }
json_field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

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

echo "3. Alta de usuario y persistencia de sesión"
stamp="$(date +%s)"
email="smoke-$stamp@orquestacion.test"
password="$(openssl rand -hex 16)"
headers="$(curl -sS -D - -o /dev/null -c "$jar" -X POST "$base/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "Origin: $BETTER_AUTH_URL" \
  -d "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"Smoke $stamp\"}")"
cookie_lines="$(printf '%s' "$headers" | grep -i '^set-cookie:' || true)"
[ -n "$cookie_lines" ] || fail "el alta no devolvió ninguna cookie:\n$headers"
case "$BETTER_AUTH_URL" in
  https://*) printf '%s' "$cookie_lines" | grep -qi ';[[:space:]]*secure' \
               || fail "BETTER_AUTH_URL es https:// pero la cookie salió sin Secure" ;;
  *)         if printf '%s' "$cookie_lines" | grep -qi ';[[:space:]]*secure'; then
               fail "BETTER_AUTH_URL es http:// y la cookie salió con Secure: el navegador no la devolvería"
             fi ;;
esac
pass "atributo Secure coherente con $BETTER_AUTH_URL"

session="$(curl -fsS -b "$jar" "$base/api/auth/get-session")" || fail "get-session falló"
printf '%s' "$session" | grep -q "$email" \
  || fail "la sesión no persistió al reenviar la cookie: $session"
pass "la sesión persiste"

echo "4. Alta de organización (hook de sitio por defecto)"
org="$(curl -fsS -b "$jar" -X POST "$base/api/auth/organization/create" \
  -H 'content-type: application/json' -H "Origin: $BETTER_AUTH_URL" \
  -d "{\"name\":\"Smoke $stamp\",\"slug\":\"smoke-$stamp\"}")" || fail "no se pudo crear la organización"
org_id="$(printf '%s' "$org" | json_field id)"
[ -n "$org_id" ] || fail "no se pudo leer el id de la organización: $org"
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
