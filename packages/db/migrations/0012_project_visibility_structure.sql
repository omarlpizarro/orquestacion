-- ADR-017 (docs/adr/017-visibilidad-de-proyectos.md), PR 2 de 3: la ESTRUCTURA
-- del modelo de proyectos reservados. No cambia ningún comportamiento: nada
-- lee `project.visibility` ni `project_member` todavía, y ninguna policy nueva
-- se agrega (eso es el PR 3). Lo que sí queda en la base:
--   * `project.visibility` (reservado por defecto) y `project_member`.
--   * `project_id` copiado en `task_update`, con FK compuesta hacia `task` y
--     un trigger que lo llena si el INSERT no lo trae (el código anterior a
--     esta migración no lo manda y tiene que seguir funcionando).
--   * `project_id` inmutable una vez fijado.
--   * `audit_log` (adelantada, ADR-017 §9) con los triggers de `project` y
--     `project_member`.
--
-- Lo de abajo NO es lo que generó drizzle-kit tal cual: se reescribió a mano
-- para respetar CLAUDE.md §6 ("las migraciones solo agregan"). Mismo caso que
-- 0009/0010 (ADR-013): el esquema de Drizzle ya declara el estado final
-- (`task_update.project_id NOT NULL`) y el snapshot de esta migración también,
-- pero lo único que esta migración aplica de verdad es una columna nullable
-- más un CHECK NOT VALID. La validación y el NOT NULL de verdad van en un
-- despliegue posterior (ver "Pendiente de validar" abajo): no pueden ir en
-- esta misma corrida porque el migrador envuelve todas las migraciones
-- pendientes en una única transacción (`PgDialect.migrate`,
-- drizzle-orm/pg-core/dialect.js:60) y el VALIDATE prolongaría el lock del ADD.
--
-- Pendiente de validar (despliegue posterior, en su propia migración, NUNCA en
-- la misma corrida que esta; se escribe a mano, `drizzle-kit generate` no
-- muestra diferencia porque el esquema ya declara el estado final):
--   ALTER TABLE project VALIDATE CONSTRAINT project_visibility_check;
--   ALTER TABLE task_update VALIDATE CONSTRAINT task_update_organization_id_task_id_project_id_task_organization_id_id_project_id_fk;
--   ALTER TABLE task_update VALIDATE CONSTRAINT task_update_project_id_not_null_check;
--   ALTER TABLE task_update ALTER COLUMN project_id SET NOT NULL;
--   ALTER TABLE task_update DROP CONSTRAINT task_update_project_id_not_null_check;
-- (el SET NOT NULL se salta el escaneo porque ya hay un CHECK validado que
-- prueba lo mismo, igual que en 0010).
--
-- SET LOCAL, no SET: rige hasta el COMMIT de la corrida y no queda pegado a la
-- conexión del pool de `app_owner`.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. `app_apply_tenant_policies()` también para tablas particionadas.
-- ---------------------------------------------------------------------------
-- La versión de 0001 solo recorría `relkind = 'r'`. Una tabla particionada
-- (`audit_log`, abajo) es `relkind = 'p'`: la función la salteaba, y como las
-- policies de una partición no se consultan cuando se lee por el padre (y las
-- del padre no cubren a quien lee una partición por su nombre), la tabla
-- habría quedado SIN RLS en silencio. Ahora cubre padres y particiones.
CREATE OR REPLACE FUNCTION app_apply_tenant_policies() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT c.relname AS table_name
    FROM information_schema.columns col
    JOIN pg_class c
      ON c.relname = col.table_name AND c.relkind IN ('r', 'p')
    JOIN pg_namespace n
      ON n.oid = c.relnamespace AND n.nspname = col.table_schema
    WHERE col.table_schema = 'public'
      AND col.column_name = 'organization_id'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', rec.table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = rec.table_name
        AND policyname = rec.table_name || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (organization_id = nullif(current_setting(''app.current_org'', true), '''')) WITH CHECK (organization_id = nullif(current_setting(''app.current_org'', true), ''''))',
        rec.table_name || '_tenant_isolation',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. `project.visibility`.
-- ---------------------------------------------------------------------------
-- Los proyectos que ya existen quedan en 'site': se les agrega la columna con
-- ese default y recién después se cambia el default a 'reserved' para los
-- nuevos. Es solo metadata del catálogo (no reescribe la tabla ni dispara el
-- trigger de `version`), y no cambia lo que ven hoy: nada los filtraba por
-- visibilidad. Con la tabla vacía es indiferente.
ALTER TABLE "project" ADD COLUMN "visibility" text DEFAULT 'site' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "visibility" SET DEFAULT 'reserved';--> statement-breakpoint
-- CHECK nuevo sobre una tabla que ya puede tener filas: NOT VALID (CLAUDE.md §6).
ALTER TABLE "project" ADD CONSTRAINT "project_visibility_check" CHECK ("project"."visibility" in ('reserved','site')) NOT VALID;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. `task`: blanco de la FK compuesta de las hijas.
-- ---------------------------------------------------------------------------
-- Un UNIQUE nuevo construye un índice bajo lock; con `task` casi vacía hoy
-- es instantáneo (la convención de CREATE INDEX CONCURRENTLY de CLAUDE.md §6
-- es para cuando haya datos en producción).
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_id_project_id_unique" UNIQUE("organization_id","id","project_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. `project_member`.
-- ---------------------------------------------------------------------------
CREATE TABLE "project_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"member_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_organization_id_project_id_project_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_member_org_project_member_active_uidx" ON "project_member" USING btree ("organization_id","project_id","member_id") WHERE "project_member"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "project_member_org_member_project_idx" ON "project_member" USING btree ("organization_id","member_id","project_id") WHERE "project_member"."deleted_at" is null;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. `task_update.project_id`.
-- ---------------------------------------------------------------------------
ALTER TABLE "task_update" ADD COLUMN "project_id" uuid;--> statement-breakpoint

-- Backfill. El dueño del esquema también está sujeto a RLS (todas las tablas
-- tienen FORCE): sin `app.current_org`, un UPDATE normal no vería ninguna
-- fila y el backfill sería un no-op silencioso. Se baja FORCE solo durante el
-- UPDATE (dentro de la misma transacción de la migración, que lo restituye
-- abajo con `app_apply_tenant_policies()` y explícitamente acá), y se
-- desactiva el trigger de `version` para no bumpear `version`/`updated_at` de
-- novedades que nadie editó.
ALTER TABLE "task_update" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_update" DISABLE TRIGGER "task_update_bump_version";--> statement-breakpoint
UPDATE "task_update" AS tu
   SET "project_id" = t."project_id"
  FROM "task" AS t
 WHERE t."organization_id" = tu."organization_id"
   AND t."id" = tu."task_id"
   AND tu."project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "task_update" ENABLE TRIGGER "task_update_bump_version";--> statement-breakpoint
ALTER TABLE "task_update" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- FK compuesta: la copia no puede diverger del proyecto de la tarea. NOT
-- VALID (CLAUDE.md §6); con `project_id` nulo la FK no se evalúa (MATCH
-- SIMPLE), así que el código anterior sigue andando.
ALTER TABLE "task_update" ADD CONSTRAINT "task_update_organization_id_task_id_project_id_task_organization_id_id_project_id_fk" FOREIGN KEY ("organization_id","task_id","project_id") REFERENCES "public"."task"("organization_id","id","project_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
-- Equivalente a NOT NULL, mismo mecanismo que 0009 (ADR-013).
ALTER TABLE "task_update" ADD CONSTRAINT "task_update_project_id_not_null_check" CHECK ("project_id" IS NOT NULL) NOT VALID;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. `project_id`: llenado e inmutabilidad, por catálogo.
-- ---------------------------------------------------------------------------
-- Llena `project_id` desde la tarea si el INSERT no lo trae. Es lo que permite
-- que el código desplegado antes de esta migración (y toda vuelta atrás a él)
-- siga insertando novedades sin conocer la columna, y deja a cualquier camino
-- futuro (workers, SQL a mano) con la copia correcta sin acordarse. Corre con
-- los permisos de quien inserta: si esa persona no puede ver la tarea no hay
-- proyecto que copiar y el CHECK/FK rechaza la fila, que es lo correcto.
CREATE OR REPLACE FUNCTION app_fill_project_id_from_task() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL AND NEW.task_id IS NOT NULL THEN
    SELECT t.project_id INTO NEW.project_id
      FROM task t
     WHERE t.organization_id = NEW.organization_id AND t.id = NEW.task_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ADR-017: el proyecto de una tarea no se puede cambiar, ni el de sus hijas.
-- No es una máquina de estados (CLAUDE.md §5 pide guard de aplicación para
-- esas): ningún endpoint mueve tareas entre proyectos, el mensaje de un error
-- de base no le sirve a nadie, y esto es solo la red de seguridad para que
-- una copia de `project_id` no pueda divergir. Una vez fijado: pasar de NULL a
-- un valor (backfill de una tabla donde es nullable) sí se permite.
CREATE OR REPLACE FUNCTION app_forbid_project_id_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_id no se puede cambiar una vez fijado (tabla %)', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Idempotentes, mismo patrón que `app_apply_tenant_policies()`. Toda migración
-- que crea una tabla con `project_id` termina con la primera; si además tiene
-- `task_id`, con la segunda (CLAUDE.md §6). Las particiones y las tablas
-- particionadas quedan afuera (`audit_log` es append-only por privilegios).
CREATE OR REPLACE FUNCTION app_apply_project_immutability() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND NOT c.relispartition
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped
      )
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class tc ON tc.oid = t.tgrelid
      WHERE tc.relname = rec.table_name
        AND t.tgname = rec.table_name || '_project_id_immutable'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW WHEN (OLD.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id) EXECUTE FUNCTION app_forbid_project_id_change()',
        rec.table_name || '_project_id_immutable',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_apply_project_id_fill() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND NOT c.relispartition
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped
      )
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'task_id' AND NOT a.attisdropped
      )
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class tc ON tc.oid = t.tgrelid
      WHERE tc.relname = rec.table_name
        AND t.tgname = rec.table_name || '_fill_project_id'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app_fill_project_id_from_task()',
        rec.table_name || '_fill_project_id',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. `audit_log` (adelantada de la migración `audit`, ADR-017 §9).
-- ---------------------------------------------------------------------------
-- Dos diferencias con lo que describía docs/data-model.md antes de este PR:
-- `actor_member_id` es `text` (los miembros son `text`, ADR-010; el documento
-- decía `uuid`), y se agrega `project_id` para filtrar la lectura por proyecto
-- (PR 3). No se declara en el esquema de Drizzle: no sabe expresar
-- `PARTITION BY`, y la aplicación nunca la consulta con el query builder.
CREATE TABLE "audit_log" (
	"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_member_id" text,
	"actor_kind" text DEFAULT 'member' NOT NULL,
	"changed" jsonb NOT NULL,
	"request_id" text,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK ("action" IN ('insert','update','delete')),
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("actor_kind" IN ('member','system','guest'))
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_org_entity_created_idx" ON "audit_log" USING btree ("organization_id","entity_type","entity_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_org_project_created_idx" ON "audit_log" USING btree ("organization_id","project_id","created_at" DESC);--> statement-breakpoint

-- Crea la partición DEFAULT y las de `p_months` meses calendario (UTC)
-- desde el mes de `p_from`. Idempotente. La usa esta migración y la usará el
-- job de mantenimiento (paso 8 del brief), que debe contemplar esto:
-- Postgres NO deja crear la partición de un mes si la DEFAULT ya tiene filas
-- de ese mes (error 23514): antes de crearla hay que sacar esas filas de la
-- DEFAULT (mover a una tabla temporal, crear la partición, reinsertar). Por
-- eso esta migración crea doce meses por adelantado: la DEFAULT no debería
-- recibir ninguna fila mientras el job no exista.
--
-- Cada partición recibe lo mismo que el padre y por el mismo motivo: RLS
-- (quien lee una partición por su nombre no pasa por las policies del padre) y
-- el REVOKE (idem para escribir). SECURITY DEFINER porque el job corre con un
-- usuario que no es dueño de la tabla; el `EXECUTE` no se otorga a nadie acá
-- (se revoca a PUBLIC) y el PR del job decide a quién.
CREATE OR REPLACE FUNCTION app_ensure_audit_partitions(p_from date, p_months integer) RETURNS void AS $$
DECLARE
  month_start date;
  part_name text;
  i integer;
BEGIN
  CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT;
  REVOKE UPDATE, DELETE ON audit_log_default FROM app_user;

  FOR i IN 0 .. p_months - 1 LOOP
    month_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    part_name := 'audit_log_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name,
      (month_start::timestamp AT TIME ZONE 'UTC')::text,
      ((month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC')::text
    );
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM app_user', part_name);
  END LOOP;

  PERFORM app_apply_tenant_policies();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_ensure_audit_partitions(date, integer) FROM PUBLIC;--> statement-breakpoint

-- El mes actual más los doce siguientes: cubre un año completo desde cualquier
-- día de este mes.
SELECT app_ensure_audit_partitions((now() AT TIME ZONE 'UTC')::date, 13);--> statement-breakpoint

-- `REVOKE` es lo que vuelve inmutable la tabla (sin él "append-only" es una
-- convención que el primer script de limpieza rompe).
REVOKE UPDATE, DELETE ON "audit_log" FROM app_user;--> statement-breakpoint

-- El registro lo escribe un trigger genérico, no la aplicación: si dependiera
-- de que cada caso de uso se acuerde de auditar, tarde o temprano uno no lo
-- haría. Solo guarda los campos que cambiaron. Un cambio sin contexto de
-- miembro (worker, script) queda con `actor_member_id` nulo y
-- `actor_kind = 'system'`.
CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger AS $$
DECLARE
  rec record;
  entity jsonb;
  diff jsonb;
  actor text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;
  entity := to_jsonb(rec);

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(n.key, jsonb_build_array(to_jsonb(OLD) -> n.key, n.value))
      INTO diff
      FROM jsonb_each(to_jsonb(NEW)) AS n
     WHERE to_jsonb(OLD) -> n.key IS DISTINCT FROM n.value
       AND n.key NOT IN ('updated_at', 'version');
    IF diff IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    diff := entity;
  END IF;

  actor := nullif(current_setting('app.current_member', true), '');

  INSERT INTO audit_log (
    organization_id, entity_type, entity_id, action,
    actor_member_id, actor_kind, changed, request_id, project_id
  ) VALUES (
    entity ->> 'organization_id',
    TG_TABLE_NAME,
    (entity ->> 'id')::uuid,
    lower(TG_OP),
    actor,
    CASE WHEN actor IS NULL THEN 'system' ELSE 'member' END,
    diff,
    nullif(current_setting('app.request_id', true), ''),
    CASE WHEN TG_TABLE_NAME = 'project'
         THEN (entity ->> 'id')::uuid
         ELSE (entity ->> 'project_id')::uuid
    END
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Después del backfill y de la creación de las particiones: ningún trigger de
-- auditoría tiene que disparar con las filas que esta migración toca.
CREATE TRIGGER project_audit
  AFTER INSERT OR UPDATE OR DELETE ON "project"
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();--> statement-breakpoint
CREATE TRIGGER project_member_audit
  AFTER INSERT OR UPDATE OR DELETE ON "project_member"
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Cierre de toda migración que crea tablas de negocio (CLAUDE.md §6).
-- ---------------------------------------------------------------------------
SELECT app_apply_tenant_policies();--> statement-breakpoint
SELECT app_apply_version_triggers();--> statement-breakpoint
SELECT app_apply_project_immutability();--> statement-breakpoint
SELECT app_apply_project_id_fill();
