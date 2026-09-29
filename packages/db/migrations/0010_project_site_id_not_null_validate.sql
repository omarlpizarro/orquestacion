-- Segundo despliegue de la conversión de `project.site_id` a NOT NULL
-- (ver 0009_project_site_id_check_not_valid.sql). Tiene que aplicarse en un
-- despliegue separado del anterior: si los dos quedaran pendientes en la
-- misma corrida de `pnpm db:migrate`, el migrador de Drizzle envuelve todas
-- las migraciones pendientes en una sola transacción (verificado en
-- `packages/db/node_modules/drizzle-orm/pg-core/dialect.js:60`,
-- `PgDialect.migrate`) y el lock exclusivo del `ADD CONSTRAINT` de 0009
-- seguiría en pie mientras el VALIDATE de acá revisa la tabla entera —
-- exactamente el problema que separar en dos pasos existe para evitar.
--
-- Antes de aplicar esto en un ambiente con datos reales, confirmar que
-- `apps/api/src/scripts/ensure-default-sites.ts` ya corrió ahí (backfill de
-- `project.site_id`, ver 0009): sin eso, el VALIDATE de abajo falla apenas
-- encuentra la primera fila vieja con `site_id` null.
--
-- VALIDATE y SET NOT NULL sí pueden ir juntos acá, a diferencia de ADD +
-- VALIDATE: para cuando esta migración corre, el ADD CONSTRAINT ... NOT
-- VALID de 0009 ya se aplicó y confirmó en un despliegue previo, así que no
-- hay ningún lock exclusivo previo que este VALIDATE pueda prolongar.
-- VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE (permite lecturas y
-- escrituras concurrentes, solo bloquea otro DDL) mientras revisa las filas
-- existentes una vez; el SET NOT NULL que sigue encuentra un CHECK ya
-- validado equivalente y Postgres se salta la revisión completa de la
-- columna (optimización de Postgres 12+), así que solo necesita un lock
-- exclusivo breve para el cambio de catálogo, no otra pasada por la tabla.
--
-- SET LOCAL lock_timeout, mismo motivo que en 0009: SET NOT NULL y DROP
-- CONSTRAINT sí piden lock exclusivo (breve, pero exclusivo) para el
-- cambio de catálogo — si hay una transacción larga abierta sobre
-- `project`, mejor fallar rápido y reintentar que encolarse y bloquear
-- toda consulta detrás. LOCAL, no un SET a secas: no debe sobrevivir al
-- COMMIT ni quedar pegado a la conexión del pool de `app_owner`.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "project" VALIDATE CONSTRAINT "project_site_id_not_null";
ALTER TABLE "project" ALTER COLUMN "site_id" SET NOT NULL;
-- El CHECK ya cumplió su función: NOT NULL en la columna prueba lo mismo,
-- así que se borra en vez de dejarlo duplicando la misma invariante para
-- siempre. DROP CONSTRAINT no necesita NOT VALID/VALIDATE: nunca revisa
-- filas, solo quita una entrada del catálogo.
ALTER TABLE "project" DROP CONSTRAINT "project_site_id_not_null";
