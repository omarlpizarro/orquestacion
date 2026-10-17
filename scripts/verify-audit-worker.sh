#!/usr/bin/env bash
# Verifica en el server que el worker de particiones del audit (ADR-018) anda:
#
#   scripts/verify-audit-worker.sh
#
# SOLO LECTURA. Muestra el estado del contenedor, sus últimos logs, las últimas
# corridas de `audit.maintain` en pg-boss y las particiones de `audit_log`, y termina
# con error si:
#   - la última corrida terminada de `audit.maintain` no está `completed` o es de hace
#     más de 48 horas (o no hay ninguna);
#   - hay menos de 2 meses de particiones por delante del mes actual;
#   - `audit_log_default` tiene filas.
# Son los mismos tres criterios del paso 7 de scripts/smoke-test.sh.
#
# Las consultas van con `default_transaction_read_only=on` (la regla de solo lectura la
# hace cumplir Postgres, no este script) y con `< /dev/null`: `compose exec -T` deja
# que psql herede el stdin del script, y dentro de un `$( )` o un bucle se lo come.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose="$repo_root/scripts/compose.sh"

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %b\n' "$1" >&2; failures=$((failures + 1)); }
failures=0

# SQL como argumento, resultado sin formato (-At) o tabular (-x opcional vía $2).
psql_ro() {
  "$compose" exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
    psql -U postgres -d orquestacion -v ON_ERROR_STOP=1 ${2:+"$2"} -c "$1" < /dev/null
}
scalar() { psql_ro "$1" -At; }

echo "1. Contenedor del worker"
"$compose" ps worker < /dev/null
state="$("$compose" ps --format '{{.State}}' worker < /dev/null)"
[ "$state" = "running" ] && pass "el contenedor está running" || fail "el contenedor del worker está '${state:-ausente}'"

echo
echo "2. Últimos logs del worker"
"$compose" logs --tail 20 --no-log-prefix worker < /dev/null

echo
echo "3. Últimas corridas de audit.maintain (pgboss.job)"
psql_ro "select state, retry_count, created_on, completed_on, output
           from pgboss.job where name = 'audit.maintain'
          order by created_on desc limit 5"
psql_ro "select name, cron from pgboss.schedule where name = 'audit.maintain'"

last="$(scalar "select state || '|' || extract(epoch from now() - completed_on)::bigint
                  from pgboss.job
                 where name = 'audit.maintain' and state in ('completed', 'failed')
                 order by completed_on desc nulls last limit 1")"
if [ -z "$last" ]; then
  fail "no hay ninguna corrida terminada de audit.maintain"
else
  last_state="${last%%|*}"; age_seconds="${last##*|}"
  if [ "$last_state" != "completed" ]; then
    fail "la última corrida terminada de audit.maintain quedó '$last_state'"
  elif [ "$age_seconds" -gt 172800 ]; then
    fail "la última corrida exitosa de audit.maintain es de hace $((age_seconds / 3600)) horas (el límite son 48)"
  else
    pass "última corrida de audit.maintain: completed, hace $((age_seconds / 60)) minutos"
  fi
fi

echo
echo "4. Particiones de audit_log"
psql_ro "select c.relname as partition, pg_size_pretty(pg_total_relation_size(c.oid)) as size
           from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'public.audit_log'::regclass
          order by c.relname desc limit 5"

ahead="$(scalar "select count(*) from pg_inherits i join pg_class c on c.oid = i.inhrelid
                  where i.inhparent = 'public.audit_log'::regclass
                    and c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}\$'
                    and c.relname > 'audit_log_' || to_char(now() at time zone 'UTC', 'YYYY_MM')")"
[ "$ahead" -ge 2 ] && pass "$ahead mes(es) de particiones por delante del actual" \
  || fail "solo $ahead mes(es) de particiones por delante del actual (se piden al menos 2)"

default_rows="$(scalar "select count(*) from public.audit_log_default")"
[ "$default_rows" = "0" ] && pass "audit_log_default está vacía" \
  || fail "audit_log_default tiene $default_rows fila(s): el job no va a poder crear la partición de ese mes (ver ADR-018)"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures verificación(es) fallaron." >&2
  exit 1
fi
echo "Worker de auditoría OK."
