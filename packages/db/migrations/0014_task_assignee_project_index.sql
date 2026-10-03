-- ADR-017: índice del acceso "solo asignado" (ver el comentario en el esquema).
-- Con `task` casi vacía hoy es instantáneo; cuando tenga datos en producción,
-- la convención de CLAUDE.md §6 para CREATE INDEX CONCURRENTLY aplica a los
-- índices que vengan después, no a este.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX "task_org_assignee_project_idx" ON "task" USING btree ("organization_id","assignee_member_id","project_id") WHERE "task"."deleted_at" is null;
