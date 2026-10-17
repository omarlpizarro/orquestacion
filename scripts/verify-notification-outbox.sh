#!/usr/bin/env bash
# Verifica en el server que la bandeja de avisos (notification_outbox, ADR-019) se está
# procesando:
#
#   scripts/verify-notification-outbox.sh
#
# SOLO LECTURA. Muestra el estado del contenedor del worker, sus últimos logs, cuántas filas
# hay pendientes y procesadas, y las pendientes con su antigüedad, intentos y último error.
# Termina con error si hay filas pendientes con más de 5 minutos de antigüedad: el worker
# las levanta cada pocos segundos, así que una fila vieja significa un worker caído, trabado
# o una fila que agotó sus intentos (esas quedan pendientes a propósito, para que se vean).
# Es el mismo criterio del paso 8 de scripts/smoke-test.sh.
#
# Las consultas van con `default_transaction_read_only=on` (la regla de solo lectura la hace
# cumplir Postgres, no este script) y con `< /dev/null`: `compose exec -T` deja que psql herede
# el stdin del script y, dentro de un `$( )` o un bucle, se lo come.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose="$repo_root/scripts/compose.sh"
max_age_minutes=5

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; failures=$((failures + 1)); }
failures=0

# SQL como argumento; el segundo, opcional, son las banderas de psql (-At para un valor suelto).
psql_ro() {
  "$compose" exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
    psql -U postgres -d orquestacion -v ON_ERROR_STOP=1 ${2:+"$2"} -c "$1" < /dev/null
}
scalar() { psql_ro "$1" -At; }

echo "1. Contenedor del worker"
"$compose" ps worker < /dev/null
state="$("$compose" ps --format '{{.State}}' worker < /dev/null)"
[ "$state" = "running" ] && pass "el contenedor está running" \
  || fail "el contenedor del worker está '${state:-ausente}'"

echo
echo "2. Últimos logs de la bandeja"
"$compose" logs --tail 30 --no-log-prefix worker < /dev/null | grep -i "notifications.outbox" || true

echo
echo "3. Estado de la bandeja"
psql_ro "select
           count(*) filter (where processed_at is null and deleted_at is null) as pendientes,
           count(*) filter (where processed_at is not null) as procesadas,
           count(*) filter (where processed_at is null and deleted_at is null and attempts > 0) as con_error
         from public.notification_outbox"

echo
echo "4. Pendientes (las más viejas primero)"
psql_ro "select id, organization_id, kind, now() - created_at as antiguedad, attempts,
                left(coalesce(last_error, ''), 120) as ultimo_error
           from public.notification_outbox
          where processed_at is null and deleted_at is null
          order by created_at limit 10"

old="$(scalar "select count(*) from public.notification_outbox
                where processed_at is null and deleted_at is null
                  and created_at < now() - interval '$max_age_minutes minutes'")"
if [ "$old" = "0" ]; then
  pass "ninguna fila pendiente lleva más de $max_age_minutes minutos"
else
  fail "$old fila(s) pendiente(s) con más de $max_age_minutes minutos: ¿el worker está caído o una fila agotó sus intentos? (ver 'ultimo_error' arriba)"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures verificación(es) fallaron." >&2
  exit 1
fi
echo "Bandeja de avisos OK."
