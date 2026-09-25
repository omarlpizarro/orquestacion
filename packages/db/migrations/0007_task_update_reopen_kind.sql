-- change-task-status (ADR-012): reabrir una tarea `done` exige motivo, igual
-- que bloquear. `reopen` es el `kind` simétrico a `block_report` para ese
-- caso — ver docs/data-model.md, sección "Novedades, adjuntos y audit trail".
ALTER TABLE "task_update" DROP CONSTRAINT "task_update_kind_check";--> statement-breakpoint
ALTER TABLE "task_update" ADD CONSTRAINT "task_update_kind_check" CHECK ("task_update"."kind" in ('comment','status_change','block_report','evidence','system','reopen'));