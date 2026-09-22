CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"site_id" uuid,
	"sop_template_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "project_organization_id_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "project_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "project_status_check" CHECK ("project"."status" in ('planning','active','on_hold','archived'))
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"path" "ltree" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"criticality" text DEFAULT 'normal' NOT NULL,
	"assignee_member_id" text,
	"planned_start_at" timestamp with time zone,
	"planned_end_at" timestamp with time zone,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"ack_required" boolean DEFAULT false NOT NULL,
	"position" text NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "task_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "task_status_check" CHECK ("task"."status" in ('pending','in_progress','blocked','in_review','done','cancelled')),
	CONSTRAINT "task_criticality_check" CHECK ("task"."criticality" in ('low','normal','high','critical')),
	CONSTRAINT "task_dates_coherent_check" CHECK ("task"."planned_end_at" is null or "task"."planned_start_at" is null or "task"."planned_end_at" >= "task"."planned_start_at")
);
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_site_id_site_organization_id_id_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."site"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_project_id_project_organization_id_id_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_parent_task_id_task_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_path_idx" ON "task" USING gist ("path");--> statement-breakpoint
CREATE INDEX "task_org_project_position_idx" ON "task" USING btree ("organization_id","project_id","position");
--> statement-breakpoint
-- Lo de arriba lo generó drizzle-kit desde el esquema. Lo de abajo es
-- manual: dos funciones de trigger genéricas (reutilizables por toda
-- migración futura que cree una tabla de negocio) y una específica de
-- `task` para mantener `path`.

-- docs/data-model.md, convención "Concurrencia": version se incrementa por
-- trigger, nunca por la aplicación. El trigger ignora lo que mande el
-- cliente en NEW.version — la concurrencia optimista la resuelve el
-- UPDATE ... WHERE version = $esperado de la aplicación, este trigger solo
-- avanza el contador tras un UPDATE exitoso.
CREATE OR REPLACE FUNCTION app_bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Idempotente, mismo patrón que app_apply_tenant_policies() (0001): toda
-- migración que crea una tabla de negocio nueva también termina con
-- `select app_apply_version_triggers();`.
CREATE OR REPLACE FUNCTION app_apply_version_triggers() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT c.relname AS table_name
    FROM information_schema.columns col
    JOIN pg_class c
      ON c.relname = col.table_name AND c.relkind = 'r'
    JOIN pg_namespace n
      ON n.oid = c.relnamespace AND n.nspname = col.table_schema
    WHERE col.table_schema = 'public'
      AND col.column_name = 'version'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = rec.table_name
        AND t.tgname = rec.table_name || '_bump_version'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_bump_version()',
        rec.table_name || '_bump_version',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- `path` (ltree) se mantiene acá, no en la aplicación (docs/data-model.md,
-- sección de `task`). El límite de tres niveles (ADR-006) NO se valida
-- acá a propósito: es una regla de dominio, y un error de base es opaco
-- para quien la viola. Esta función solo mantiene el dato consistente; el
-- handler ya verificó la profundidad antes de llegar al INSERT.
-- `replace(..., '-', '')` porque un label de ltree no acepta guiones, y los
-- ids de negocio son UUID.
CREATE OR REPLACE FUNCTION task_maintain_path() RETURNS trigger AS $$
DECLARE
  parent_path ltree;
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    NEW.path := text2ltree(replace(NEW.id::text, '-', ''));
  ELSE
    SELECT path INTO parent_path FROM task
      WHERE id = NEW.parent_task_id AND organization_id = NEW.organization_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'parent_task_id % no existe en esta organización', NEW.parent_task_id;
    END IF;
    NEW.path := parent_path || text2ltree(replace(NEW.id::text, '-', ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_maintain_path
  BEFORE INSERT OR UPDATE OF parent_task_id ON task
  FOR EACH ROW EXECUTE FUNCTION task_maintain_path();

SELECT app_apply_tenant_policies();
SELECT app_apply_version_triggers();