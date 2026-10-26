#!/usr/bin/env bash
# Crea una organización de DEMO para poder mostrar el producto. SOLO DEMO.
#
#   scripts/seed-demo.sh --demo
#
# Se corre a mano, en el server, dentro del clon del repo (lo corre Omar: escribe en la base, así que
# no lo corre la prueba de humo ni nadie más, CLAUDE.md §12). Sin `--demo` se niega: crea cuentas con
# una contraseña conocida y no tiene que correr nunca contra un ambiente con datos de un cliente.
#
# Qué deja:
#   - tres cuentas, todas con la misma contraseña (`DEMO_PASSWORD`, de infra/docker/.env; si falta se
#     genera en la primera corrida y se agrega ahí, como `SMOKE_PASSWORD`):
#       laura@demo.orquestacion.test    dueña (owner)
#       carlos@demo.orquestacion.test   gerente (manager)
#       diego@demo.orquestacion.test    operario (operator)
#   - la organización "Constructora Demo" (slug `demo-obra`) con su sitio por defecto, y los tres
#     como miembros: se invita y se acepta por la API, así corren los mismos hooks que en producción
#     (acceso al sitio incluido);
#   - un proyecto abierto al sitio, "Edificio Libertador — Etapa 1", con tareas y subtareas en todos los
#     estados que muestra la guía de diseño (una vencida, una bloqueada con motivo, una terminada...),
#     comentarios, y los avisos que eso genera;
#   - un proyecto RESERVADO, "Presupuesto y contrataciones 2027", donde el operario no ve nada y el
#     gerente ve solo la tarea que le asignaron: para mostrar la visibilidad (ADR-017).
#
# Las tareas "de hoy" llevan ventanas que cubren la jornada entera (hasta las 23:00 o 23:30), para que sigan
# siendo "de hoy" y no "vencidas" a cualquier hora en que se corra el script.
#
# Es IDEMPOTENTE: ids y `client_mutation_id` fijos, y cada estado se consulta antes de cambiarlo, así
# que correrlo N veces no duplica nada y retoma donde se cortó. Las fechas planificadas son relativas
# al día de la PRIMERA corrida (el sitio está en Argentina, UTC-3 todo el año); volver a correrlo no las
# corre. Para una demo con fechas frescas hay que empezar de cero (otra organización o una base nueva).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"
compose="$repo_root/scripts/compose.sh"

if [ "${1:-}" != "--demo" ]; then
  cat >&2 <<'EOF'
Uso: scripts/seed-demo.sh --demo

Crea cuentas y datos de DEMO con una contraseña conocida. Solo para el servidor de demo, nunca para un
ambiente con datos de un cliente. Hay que pasar --demo para confirmarlo.
EOF
  exit 2
fi

[ -f "$env_file" ] || { echo "Falta $env_file" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [ -z "${DEMO_PASSWORD:-}" ]; then
  DEMO_PASSWORD="$(openssl rand -hex 12)"
  printf '\n# Cuentas de demo (scripts/seed-demo.sh). Generado en la primera corrida.\nDEMO_PASSWORD=%s\n' \
    "$DEMO_PASSWORD" >> "$env_file"
  echo "Aviso: DEMO_PASSWORD no estaba en $env_file; se generó y se agregó."
fi

base="http://127.0.0.1:${API_HOST_PORT:-18020}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

org_slug="demo-obra"
org_name="Constructora Demo"
email_of() { printf '%s@demo.orquestacion.test' "$1"; }

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; exit 1; }
json_field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
json_number() { grep -o "\"$1\":[0-9]*" | head -1 | cut -d: -f2; }

# Con la identidad de quien pide (cada usuario tiene su cookie). Deja el cuerpo en $work_dir/body y
# devuelve el código HTTP. `Origin` lo exige Better Auth en pedidos con cookies.
call() {
  local user="$1" method="$2" path="$3" data="${4:-}"
  local args=(-sS -o "$work_dir/body" -w '%{http_code}' -b "$work_dir/$user.jar" -c "$work_dir/$user.jar"
    -X "$method" "$base$path" -H "Origin: $BETTER_AUTH_URL")
  if [ -n "$data" ]; then args+=(-H 'content-type: application/json' -d "$data"); fi
  curl "${args[@]}"
}
# Igual que `call`, pero corta si el código no es el esperado.
expect() {
  local want="$1" what="$2" status
  shift 2
  status="$(call "$@")"
  [ "$status" = "$want" ] || fail "$what: HTTP $status (se esperaba $want): $(cat "$work_dir/body")"
}

psql_read() {
  "$compose" exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
    psql -U postgres -d orquestacion -v ON_ERROR_STOP=1 -Atc "$1" < /dev/null
}

# UUIDv7 fijos y válidos (versión 7, variante 8) en un espacio propio de la demo: <tipo>-<n>.
demo_id() { printf '019500d%s-0000-7000-8000-%012d' "$1" "$2"; }
project_id() { demo_id 1 "$1"; }
task_id() { demo_id 2 "$1"; }
mutation_id() { demo_id 3 "$1"; }
comment_id() { demo_id 4 "$1"; }

# "AAAA-MM-DDTHH:mm" en la hora del sitio (Argentina, UTC-3 todo el año), a <días> de hoy.
local_dt() { printf '%sT%s' "$(date -u -d "3 hours ago $1 days" +%F)" "$2"; }

echo "1. Cuentas de demo"
for user in laura carlos diego; do
  name="$(case "$user" in laura) echo 'Laura Benítez' ;; carlos) echo 'Carlos Medina' ;; diego) echo 'Diego Fernández' ;; esac)"
  credentials="{\"email\":\"$(email_of "$user")\",\"password\":\"$DEMO_PASSWORD\"}"
  status="$(call "$user" POST /api/auth/sign-in/email "$credentials")"
  if [ "$status" = "200" ]; then
    pass "$(email_of "$user") ya existía: sesión iniciada"
  else
    expect 200 "no se pudo crear $(email_of "$user") (si la cuenta existe con otra contraseña, revisá DEMO_PASSWORD en $env_file)" \
      "$user" POST /api/auth/sign-up/email \
      "{\"email\":\"$(email_of "$user")\",\"password\":\"$DEMO_PASSWORD\",\"name\":\"$name\"}"
    pass "$(email_of "$user") creada"
  fi
done

echo "2. Organización \"$org_name\""
expect 200 "no se pudo listar las organizaciones" laura GET /api/auth/organization/list
if grep -q "\"slug\":\"$org_slug\"" "$work_dir/body"; then
  org_id="$(json_field id < "$work_dir/body")"
  pass "la organización '$org_slug' ya existía"
else
  expect 200 "no se pudo crear la organización" laura POST /api/auth/organization/create \
    "{\"name\":\"$org_name\",\"slug\":\"$org_slug\"}"
  org_id="$(json_field id < "$work_dir/body")"
  pass "la organización '$org_slug' creada"
fi
[ -n "$org_id" ] || fail "no se pudo leer el id de la organización"
expect 200 "no se pudo activar la organización" laura POST /api/auth/organization/set-active \
  "{\"organizationId\":\"$org_id\"}"

echo "3. Miembros (se invita y se acepta por la API: corren los mismos hooks que en producción)"
for pair in carlos:manager diego:operator; do
  user="${pair%%:*}" role="${pair##*:}"
  status="$(call laura POST /api/auth/organization/invite-member \
    "{\"email\":\"$(email_of "$user")\",\"role\":\"$role\",\"organizationId\":\"$org_id\"}")"
  if [ "$status" = "200" ]; then
    invitation_id="$(json_field id < "$work_dir/body" | head -1)"
  elif grep -q 'ALREADY_A_MEMBER' "$work_dir/body"; then
    pass "$(email_of "$user") ya era miembro ($role)"
    continue
  else
    # Una invitación pendiente de una corrida cortada a mitad de camino.
    invitation_id="$(psql_read "select id from auth.invitation where organization_id = '$org_id' and email = '$(email_of "$user")' and status = 'pending' order by created_at desc limit 1")"
    [ -n "$invitation_id" ] || fail "no se pudo invitar a $(email_of "$user"): HTTP $status: $(cat "$work_dir/body")"
  fi
  expect 200 "$(email_of "$user") no pudo aceptar la invitación" "$user" POST /api/auth/organization/accept-invitation \
    "{\"invitationId\":\"$invitation_id\"}"
  pass "$(email_of "$user") es miembro ($role)"
done
for user in carlos diego; do
  expect 200 "no se pudo activar la organización para $user" "$user" POST /api/auth/organization/set-active \
    "{\"organizationId\":\"$org_id\"}"
done

member_of() {
  psql_read "select m.id from auth.member m join auth.\"user\" u on u.id = m.user_id where m.organization_id = '$org_id' and u.email = '$(email_of "$1")'"
}
carlos_member="$(member_of carlos)"
diego_member="$(member_of diego)"
[ -n "$carlos_member" ] && [ -n "$diego_member" ] || fail "no se encontraron los miembros de la demo"

# Acceso al sitio de los miembros nuevos: ya lo dio el hook al aceptar la invitación; esto lo repara si
# alguno quedó sin él (es idempotente, y es el mismo script operativo que usa la prueba de humo).
"$compose" run --rm --no-deps scripts node dist/src/scripts/ensure-default-sites.js < /dev/null | grep -E 'Fallidas' | sed 's/^/     /'

echo "4. Proyectos"
create_project() { # n código nombre visibilidad descripción
  expect 200 "no se pudo crear el proyecto $2" laura POST /projects \
    "{\"client_mutation_id\":\"$(mutation_id "$1")\",\"id\":\"$(project_id "$1")\",\"code\":\"$2\",\"name\":\"$3\",\"visibility\":\"$4\",\"description\":\"$5\"}"
  pass "proyecto $2 — $3 ($4)"
}
create_project 1 OBRA-001 "Edificio Libertador — Etapa 1" site "Estructura de hormigón armado de un edificio de seis pisos: fundaciones, columnas y losas."
create_project 2 GERENCIA-001 "Presupuesto y contrataciones 2027" reserved "Proyecto reservado de la gerencia general."
p1="$(project_id 1)"
p2="$(project_id 2)"

echo "5. Tareas"
# n proyecto título criticidad responsable(member id o vacío) inicio fin [padre] [descripción]
create_task() {
  local n="$1" project="$2" title="$3" criticality="$4" assignee="$5" start="$6" end="$7" parent="${8:-}" description="${9:-}"
  local json="{\"client_mutation_id\":\"$(mutation_id $((100 + n)))\",\"id\":\"$(task_id "$n")\",\"project_id\":\"$project\",\"title\":\"$title\",\"criticality\":\"$criticality\""
  [ -n "$assignee" ] && json="$json,\"assignee_member_id\":\"$assignee\""
  [ -n "$start" ] && json="$json,\"planned_start_at\":\"$start\""
  [ -n "$end" ] && json="$json,\"planned_end_at\":\"$end\""
  [ -n "$parent" ] && json="$json,\"parent_task_id\":\"$parent\""
  [ -n "$description" ] && json="$json,\"description\":\"$description\""
  expect 200 "no se pudo crear la tarea \"$title\"" laura POST /projects/tasks "$json}"
  pass "$title"
}
# usuario tarea estado [motivo]: lleva la tarea a ese estado, sin repetir si ya está ahí.
status_code() {
  case "$1" in in_progress) echo 1 ;; blocked) echo 2 ;; in_review) echo 3 ;; done) echo 4 ;; cancelled) echo 5 ;; *) echo 9 ;; esac
}
set_status() {
  local user="$1" n="$2" to="$3" reason="${4:-}" current version json
  expect 200 "no se pudo leer la tarea $n" "$user" GET "/projects/tasks/$(task_id "$n")"
  current="$(json_field status < "$work_dir/body")"
  [ "$current" = "$to" ] && return 0
  version="$(json_number version < "$work_dir/body")"
  json="{\"client_mutation_id\":\"$(mutation_id $((1000 + n * 10 + $(status_code "$to"))))\",\"expected_version\":$version,\"to_status\":\"$to\""
  [ -n "$reason" ] && json="$json,\"reason\":\"$reason\""
  expect 200 "no se pudo pasar la tarea $n a $to" "$user" PATCH "/projects/tasks/$(task_id "$n")/status" "$json}"
}
# usuario tarea n texto
add_comment() {
  expect 200 "no se pudo comentar la tarea $2" "$1" POST "/projects/tasks/$(task_id "$2")/comments" \
    "{\"client_mutation_id\":\"$(mutation_id $((3000 + $3)))\",\"id\":\"$(comment_id "$3")\",\"body\":\"$4\"}"
}

echo "   Edificio Libertador"
create_task 1 "$p1" "Replanteo y nivelación del terreno" normal "$diego_member" "$(local_dt -6 08:00)" "$(local_dt -5 17:00)"
create_task 2 "$p1" "Excavación de fundaciones" high "$diego_member" "$(local_dt -3 08:00)" "$(local_dt -1 17:00)" "" \
  "Excavar las zapatas según el plano de fundaciones, con la cota de replanteo ya aprobada."
create_task 3 "$p1" "Hormigonado de zapatas" critical "$carlos_member" "$(local_dt 1 07:00)" "$(local_dt 2 16:00)"
create_task 4 "$p1" "Armado de hierros" normal "$diego_member" "$(local_dt 0 06:00)" "$(local_dt 0 23:00)" "$(task_id 3)"
create_task 5 "$p1" "Encofrado de zapatas" normal "$diego_member" "$(local_dt 0 12:00)" "$(local_dt 0 23:30)" "$(task_id 3)"
create_task 6 "$p1" "Instalación eléctrica provisoria" high "$diego_member" "$(local_dt 0 09:00)" "$(local_dt 1 12:00)"
create_task 7 "$p1" "Tramitar el permiso de obra en la municipalidad" high "" "$(local_dt -4 09:00)" "$(local_dt -1 18:00)"
create_task 8 "$p1" "Recepción de hierro de 12 mm" normal "$carlos_member" "$(local_dt 0 07:00)" "$(local_dt 0 23:30)"
create_task 9 "$p1" "Ensayo de probetas de hormigón" normal "$carlos_member" "$(local_dt 3 09:00)" "$(local_dt 3 12:00)"
create_task 10 "$p1" "Alquiler de grúa torre" low "" "" ""
echo "   Presupuesto y contrataciones 2027 (reservado)"
create_task 11 "$p2" "Revisar el presupuesto de materiales del segundo semestre" normal "$carlos_member" "$(local_dt 2 09:00)" "$(local_dt 4 18:00)"

echo "6. Estados y novedades (cada uno lo hace quien corresponde)"
set_status diego 1 in_progress
set_status diego 1 done
set_status diego 2 in_progress
set_status diego 6 in_progress
set_status diego 6 blocked "Falta el cable de 4 mm: el proveedor lo entrega el jueves y no podemos energizar el tablero sin él."
set_status carlos 8 in_progress
set_status carlos 9 in_progress
set_status carlos 9 in_review
set_status laura 10 cancelled
pass "estados: terminada, en curso (vencida), bloqueada con motivo, en revisión, cancelada, pendientes"
add_comment diego 2 1 "Llevamos el 60 % de la excavación. Falta la zona norte, que tiene agua."
add_comment carlos 6 2 "Ya pedí el cable a otro proveedor, llega mañana a primera hora."
pass "comentarios"

echo "7. Avisos"
# El bloqueo deja un pedido en la bandeja y el worker completa la audiencia en unos segundos.
pending="1"
for _ in $(seq 1 12); do
  pending="$(psql_read "select count(*) from notification_outbox where organization_id = '$org_id' and processed_at is null")"
  [ "$pending" = "0" ] && break
  sleep 5
done
if [ "$pending" = "0" ]; then
  pass "la bandeja de avisos está al día"
else
  echo "  Aviso: $pending pedido(s) de avisos siguen pendientes; ¿el worker está arriba? (scripts/verify-notification-outbox.sh)"
fi

cat <<EOF

Demo lista. Organización "$org_name" (slug $org_slug).

  Dueña:      $(email_of laura)
  Gerente:    $(email_of carlos)
  Operario:   $(email_of diego)
  Contraseña: $DEMO_PASSWORD   (la misma para las tres; está en $env_file como DEMO_PASSWORD)

  Iniciar sesión en: $BETTER_AUTH_URL

Qué mirar: el operario ve su día (una tarea vencida, una bloqueada) y NO ve el proyecto reservado; el
gerente ve ese proyecto solo por la tarea que le asignaron; la dueña ve todo y tiene el aviso del
bloqueo de la instalación eléctrica.
EOF
