CREATE TABLE "guest_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"label" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_by_member_id" text NOT NULL,
	CONSTRAINT "guest_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "guest_link_scope_kind_check" CHECK ("guest_link"."scope_kind" in ('project','task','milestones'))
);
--> statement-breakpoint
CREATE TABLE "member_site_access" (
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "member_site_access_member_id_site_id_pk" PRIMARY KEY("member_id","site_id"),
	CONSTRAINT "member_site_access_role_check" CHECK ("member_site_access"."role" in ('manager','operator'))
);
--> statement-breakpoint
CREATE TABLE "organization_profile" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"industry" text NOT NULL,
	"timezone" text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"locale" text DEFAULT 'es-AR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_profile_industry_check" CHECK ("organization_profile"."industry" in ('gastronomia','agro','salud','mineria','energia','construccion','eventos','otro'))
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"address" text,
	"geo" "point",
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "site_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "organization_profile" ADD CONSTRAINT "organization_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Toda migración que crea una tabla de negocio nueva termina con esto
-- (CLAUDE.md §6): aplica RLS a las cuatro tablas de arriba, idempotente.
SELECT app_apply_tenant_policies();