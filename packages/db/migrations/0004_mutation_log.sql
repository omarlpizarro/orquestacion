CREATE TABLE "mutation_log" (
	"client_mutation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid,
	"result" text NOT NULL,
	"rejection_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_log_result_check" CHECK ("mutation_log"."result" in ('applied','rejected','duplicate'))
);
--> statement-breakpoint
ALTER TABLE "mutation_log" ADD CONSTRAINT "mutation_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
SELECT app_apply_tenant_policies();