-- Audit trail sobre `task` (brief de fase 2, paso 8 / bloque B, paso 1): el mismo
-- trigger genérico que ya audita `project` y `project_member` desde la 0012.
-- `audit_trigger()` no cambia: arma la entrada con el actor, el request y el
-- `project_id` de la propia fila (`task` lo tiene), así que la entrada hereda la
-- visibilidad por proyecto de `audit_log` (acceso completo al proyecto, ADR-017 §3);
-- quien tiene "solo asignado" no la ve.
--
-- Solo agrega un trigger: el código anterior sigue funcionando sin tocar nada.
-- Cada INSERT, UPDATE o DELETE de `task` escribe una fila en `audit_log` dentro de
-- la misma transacción; un UPDATE que solo cambia `updated_at`/`version` (el
-- trigger de versión) no escribe nada. Las tareas que ya existen no tienen
-- entrada de alta: el trigger registra desde acá en adelante.
--
-- `CREATE TRIGGER` toma `SHARE ROW EXCLUSIVE` sobre `task` (bloquea escrituras un
-- instante, no lecturas). `lock_timeout` con SET LOCAL: si hay una transacción
-- larga abierta sobre `task`, falla rápido en vez de encolarse y congelar la
-- tabla, y se reintenta después. LOCAL para que no quede pegado a la conexión de
-- `app_owner`.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TRIGGER task_audit
  AFTER INSERT OR UPDATE OR DELETE ON "task"
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();
