CREATE TYPE "public"."lease_status" AS ENUM('active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."quota_event_type" AS ENUM('LEASE_CLAIM', 'LEASE_RELEASE', 'LEASE_EXPIRE', 'LOAN_CREATE', 'LOAN_REPAY', 'LOAN_EXPIRE', 'LOAN_CANCEL', 'ALLOCATION_ADJUST', 'RECONCILIATION_CORRECTION');--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "lease_status" DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quota_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "quota_event_type" NOT NULL,
	"org_id" uuid NOT NULL,
	"counterpart_org_id" uuid,
	"service_id" uuid,
	"lease_id" uuid,
	"loan_id" uuid,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"idempotency_key" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_counterpart_org_id_organizations_id_fk" FOREIGN KEY ("counterpart_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_leases_active_by_service" ON "leases" USING btree ("service_id","expires_at") WHERE "leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_leases_expiry_scan" ON "leases" USING btree ("expires_at") WHERE "leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_quota_events_org_time" ON "quota_events" USING btree ("org_id","created_at" DESC NULLS LAST);