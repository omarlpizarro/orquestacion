CREATE TABLE "task_update" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "task_update_kind_check" CHECK ("task_update"."kind" in ('comment','status_change','block_report','evidence','system'))
);
--> statement-breakpoint
ALTER TABLE "task_update" ADD CONSTRAINT "task_update_organization_id_task_id_task_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_update_org_task_created_idx" ON "task_update" USING btree ("organization_id","task_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- Lo de arriba lo generó drizzle-kit desde el esquema. Las dos funciones que
-- siguen ya existen (0001_roles_rls.sql, 0005_projects.sql): CLAUDE.md §6
-- pide terminar toda migración que crea una tabla de negocio nueva
-- reaplicándolas, son idempotentes y cubren `task_update` sin tener que
-- escribir su policy de RLS ni su trigger de `version` a mano.
SELECT app_apply_tenant_policies();
SELECT app_apply_version_triggers();