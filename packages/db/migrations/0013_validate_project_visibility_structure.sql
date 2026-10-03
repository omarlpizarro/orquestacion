-- Segundo despliegue de la estructura de ADR-017 (ver el encabezado de
-- 0012_project_visibility_structure.sql): valida las restricciones que 0012
-- dejó `NOT VALID`. Tiene que aplicarse en un despliegue posterior al de 0012,
-- nunca en la misma corrida: el migrador de Drizzle envuelve todas las
-- migraciones pendientes en una sola transacción (`PgDialect.migrate`,
-- drizzle-orm/pg-core/dialect.js:60) y el VALIDATE revisaría la tabla entera
-- todavía dentro del lock exclusivo del ADD CONSTRAINT. Mismo criterio que
-- 0010 respecto de 0009 (ADR-013). 0012 ya está desplegada cuando esta llega
-- a un ambiente, así que la restricción de esa migración ya se confirmó.
--
-- VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE (permite lecturas y
-- escrituras concurrentes). El SET NOT NULL encuentra el CHECK ya validado y
-- Postgres se salta la pasada completa por la columna, así que solo pide un
-- lock exclusivo breve para el catálogo; con `lock_timeout`, si hay una
-- transacción larga abierta sobre `task_update` falla rápido en vez de
-- encolarse y bloquear toda consulta detrás. LOCAL: no queda pegado a la
-- conexión del pool de `app_owner`.
--
-- Código anterior a 0012 sigue andando contra esto: no manda `project_id`, pero
-- el trigger `task_update_fill_project_id` lo llena en el INSERT.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_visibility_check";
--> statement-breakpoint
ALTER TABLE "task_update" VALIDATE CONSTRAINT "task_update_organization_id_task_id_project_id_task_organization_id_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "task_update" VALIDATE CONSTRAINT "task_update_project_id_not_null_check";
--> statement-breakpoint
ALTER TABLE "task_update" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
-- El CHECK ya cumplió su función: NOT NULL en la columna prueba lo mismo.
ALTER TABLE "task_update" DROP CONSTRAINT "task_update_project_id_not_null_check";
