-- Notificaciones dentro de la app (ADR-019): `notification` y su bandeja de pendientes
-- `notification_outbox`. Solo agrega tablas: el código anterior sigue andando.
--
-- Las dos FK hacia `task` van DENTRO del `CREATE TABLE` y no como `ALTER TABLE ... ADD
-- CONSTRAINT` (que es lo que genera drizzle-kit). Verificado: desde la `0015`, agregar una
-- FK hacia `task` con `ALTER` falla con `42501`, porque el escaneo de validación lee `task`
-- como `app_owner` bajo sus policies RLS, que llaman a funciones auxiliares cuyo EXECUTE
-- `app_owner` no tiene a propósito (ADR-017). Una FK declarada en el `CREATE` de una tabla
-- nueva no escanea nada. Lo mismo vale para cualquier tabla futura con FK hacia `task`.
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"recipient_member_id" text NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"template_key" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"provider_message_id" text,
	"error" text,
	CONSTRAINT "notification_organization_id_task_id_task_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."task"("organization_id","id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "notification_organization_id_task_id_project_id_task_organization_id_id_project_id_fk" FOREIGN KEY ("organization_id","task_id","project_id") REFERENCES "public"."task"("organization_id","id","project_id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "notification_org_dedupe_key_unique" UNIQUE("organization_id","dedupe_key"),
	CONSTRAINT "notification_channel_check" CHECK ("notification"."channel" in ('inapp','push','email','whatsapp')),
	CONSTRAINT "notification_status_check" CHECK ("notification"."status" in ('queued','sent','delivered','failed','suppressed')),
	CONSTRAINT "notification_project_task_check" CHECK ("notification"."task_id" is null or "notification"."project_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "notification_outbox_org_kind_entity_unique" UNIQUE("organization_id","kind","entity_id"),
	CONSTRAINT "notification_outbox_attempts_check" CHECK ("notification_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "notification_org_recipient_id_idx" ON "notification" USING btree ("organization_id","recipient_member_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_org_recipient_unread_idx" ON "notification" USING btree ("organization_id","recipient_member_id") WHERE "notification"."read_at" is null and "notification"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notification_outbox_org_pending_idx" ON "notification_outbox" USING btree ("organization_id","created_at") WHERE "notification_outbox"."processed_at" is null;
--> statement-breakpoint
-- Lo de arriba lo generó drizzle-kit desde el esquema (ADR-019). Lo que sigue es a mano.
--
-- Las cinco funciones `app_apply_*` ya existen (0001, 0005, 0012, 0015): CLAUDE.md §6 pide
-- terminar con ellas toda migración que crea una tabla de negocio. `notification` tiene
-- `project_id` y `task_id`, así que recibe las cinco: RLS de tenant, trigger de `version`,
-- inmutabilidad y relleno de `project_id`, y las policies por proyecto (acceso completo, o la
-- tarea asignada). `notification_outbox` no tiene ni `project_id` ni `task_id`: solo las dos
-- primeras la alcanzan.
SELECT app_apply_tenant_policies();--> statement-breakpoint
SELECT app_apply_version_triggers();--> statement-breakpoint
SELECT app_apply_project_immutability();--> statement-breakpoint
SELECT app_apply_project_id_fill();--> statement-breakpoint
SELECT app_apply_project_policies();--> statement-breakpoint

-- notification: cada persona lee y marca como leído SOLO lo suyo. RESTRICTIVE y por
-- comando: se suma (AND) a la de organización y a la del proyecto, y NO aplica a INSERT,
-- porque quien bloquea o asigna crea avisos para otros. Ni siquiera `owner`/`director`
-- (privilegiados para el resto del modelo) leen los avisos ajenos: por eso NO se usa
-- `app_is_privileged()` acá. La policy del proyecto sigue valiendo: quien pierde el
-- acceso al proyecto deja de ver sus avisos.
-- Los avisos que crea otro (el worker, la API) se insertan sin RETURNING: un RETURNING
-- evaluaría esta policy sobre una fila que no es de quien inserta.
CREATE POLICY "notification_recipient_select" ON "notification" AS RESTRICTIVE FOR SELECT
  USING (recipient_member_id = nullif(current_setting('app.current_member', true), ''));--> statement-breakpoint
CREATE POLICY "notification_recipient_update" ON "notification" AS RESTRICTIVE FOR UPDATE
  USING (recipient_member_id = nullif(current_setting('app.current_member', true), ''))
  WITH CHECK (recipient_member_id = nullif(current_setting('app.current_member', true), ''));--> statement-breakpoint

-- notification_outbox: el worker la recorre ENTERA, de todas las organizaciones, para
-- encontrar qué falta procesar; con solo la policy de organización esa lectura vería cero
-- filas. Esta policy permisiva de SELECT concede la lectura transversal solo a la
-- identidad `app_worker` con el contexto de sistema (mismo criterio que ADR-017 §5: lo
-- concede la identidad de la conexión, no un valor que la aplicación escribe). NO usa
-- `app_is_privileged()`: su rama de owner/director dejaría a un dueño de una organización
-- leer la bandeja de las demás. Procesar una fila (bloquearla y marcarla) ya ocurre dentro
-- de una transacción de sistema de SU organización, bajo la policy de organización.
CREATE POLICY "notification_outbox_system_scan" ON "notification_outbox" AS PERMISSIVE FOR SELECT
  USING (nullif(current_setting('app.scope', true), '') = 'system' AND session_user = 'app_worker');
