#!/usr/bin/env bash
# Verifica en el server la lectura de tareas (get-task y list-project-tasks):
#
#   scripts/verify-read-tasks.sh
#
# Con la cuenta de humo, en el proyecto SMOKE-001 de la organización de humo:
#   1. Se asegura de que existan una tarea raíz y una subtarea con ids fijos (si ya
#      existen, el reintento idempotente devuelve lo mismo y no crea nada).
#   2. GET /projects/{id}/tasks trae la raíz con la subtarea colgando de ella.
#   3. GET /projects/tasks/{id} trae la tarea con su árbol y sus novedades.
#   4. Una tarea que no existe responde 404 task_not_found.
#
# ESCRIBE en la base la primera vez (dos tareas en SMOKE-001); las siguientes
# corridas no agregan nada. Va con las mismas credenciales y el mismo .env que
# scripts/smoke-test.sh, que tiene que haber corrido antes (crea la cuenta, la
# organización y el proyecto).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"

[ -f "$env_file" ] || { echo "Falta $env_file" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
[ -n "${SMOKE_PASSWORD:-}" ] || { echo "Falta SMOKE_PASSWORD en $env_file: corré scripts/smoke-test.sh primero." >&2; exit 1; }

base="http://127.0.0.1:${API_HOST_PORT:-18020}"
work_dir="$(mktemp -d)"
jar="$work_dir/cookies"
trap 'rm -rf "$work_dir"' EXIT

# UUIDv7 fijos y válidos (versión 7, variante 8): ids de las tareas y de las
# mutaciones, para que correr el script de nuevo sea un reintento idempotente.
root_id="01950000-0000-7000-8000-0000000000b1"
child_id="01950000-0000-7000-8000-0000000000b2"
root_mutation="01950000-0000-7000-8000-0000000000c1"
child_mutation="01950000-0000-7000-8000-0000000000c2"
missing_id="01950000-0000-7000-8000-0000000000ff"

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; exit 1; }

# Método, ruta y cuerpo opcional. Deja el cuerpo en $work_dir/body y devuelve el HTTP.
request() {
  if [ "$#" -ge 3 ]; then
    curl -sS -o "$work_dir/body" -w '%{http_code}' -b "$jar" -c "$jar" -X "$1" "$base$2" \
      -H 'content-type: application/json' -H "Origin: $BETTER_AUTH_URL" -d "$3"
  else
    curl -sS -o "$work_dir/body" -w '%{http_code}' -b "$jar" -c "$jar" -X "$1" "$base$2"
  fi
}

echo "1. Sesión de la cuenta de humo y proyecto SMOKE-001"
status="$(request POST /api/auth/sign-in/email \
  "{\"email\":\"smoke@orquestacion.test\",\"password\":\"$SMOKE_PASSWORD\"}")"
[ "$status" = "200" ] || fail "no se pudo iniciar sesión (HTTP $status): $(cat "$work_dir/body")"
org_id="$(curl -fsS -b "$jar" "$base/api/auth/organization/list" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$org_id" ] || fail "la cuenta de humo no tiene organización: corré scripts/smoke-test.sh primero"
status="$(request POST /api/auth/organization/set-active "{\"organizationId\":\"$org_id\"}")"
[ "$status" = "200" ] || fail "no se pudo activar la organización (HTTP $status)"
project_id="$("$compose" exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
  psql -U postgres -d orquestacion -Atc \
  "select id from project where organization_id = '$org_id' and code = 'SMOKE-001' and deleted_at is null" < /dev/null)"
[ -n "$project_id" ] || fail "no existe el proyecto SMOKE-001: corré scripts/smoke-test.sh primero"
pass "proyecto SMOKE-001 = $project_id"

echo "2. Tarea raíz y subtarea (ids fijos, idempotente)"
status="$(request POST /projects/tasks \
  "{\"client_mutation_id\":\"$root_mutation\",\"id\":\"$root_id\",\"project_id\":\"$project_id\",\"title\":\"Verificación de lectura (raíz)\"}")"
[ "$status" = "200" ] || fail "no se pudo crear la tarea raíz (HTTP $status): $(cat "$work_dir/body")"
status="$(request POST /projects/tasks \
  "{\"client_mutation_id\":\"$child_mutation\",\"id\":\"$child_id\",\"project_id\":\"$project_id\",\"parent_task_id\":\"$root_id\",\"title\":\"Verificación de lectura (subtarea)\"}")"
[ "$status" = "200" ] || fail "no se pudo crear la subtarea (HTTP $status): $(cat "$work_dir/body")"
pass "tarea raíz $root_id y subtarea $child_id"

echo "3. GET /projects/{id}/tasks: la raíz con la subtarea colgando"
status="$(request GET "/projects/$project_id/tasks")"
[ "$status" = "200" ] || fail "la lista respondió HTTP $status: $(cat "$work_dir/body")"
grep -q '"access_level":"full"' "$work_dir/body" || fail "access_level no es full: $(cat "$work_dir/body")"
grep -Eq "\"id\":\"$root_id\"[^]]*\"subtasks\":\[\{\"id\":\"$child_id\"" "$work_dir/body" \
  || fail "la subtarea no cuelga de la raíz en la lista: $(cat "$work_dir/body")"
pass "la lista trae la raíz con su subtarea"

echo "4. GET /projects/tasks/{id}: la tarea con su árbol y sus novedades"
status="$(request GET "/projects/tasks/$root_id")"
[ "$status" = "200" ] || fail "la tarea respondió HTTP $status: $(cat "$work_dir/body")"
grep -Eq "\"subtasks\":\[\{\"id\":\"$child_id\"" "$work_dir/body" \
  || fail "la subtarea no está en el árbol de la tarea: $(cat "$work_dir/body")"
grep -q '"updates":\[' "$work_dir/body" || fail "la respuesta no trae el arreglo de novedades"
grep -q '"updates_truncated":false' "$work_dir/body" || fail "updates_truncated no es false"
pass "la tarea trae su subárbol y sus novedades"

echo "5. Una tarea que no existe responde 404"
status="$(request GET "/projects/tasks/$missing_id")"
[ "$status" = "404" ] || fail "se esperaba 404 y respondió HTTP $status: $(cat "$work_dir/body")"
grep -q '"domain_code":"task_not_found"' "$work_dir/body" || fail "el 404 no trae task_not_found"
pass "404 task_not_found"

echo
echo "Verificación de lectura de tareas OK."
