CREATE TYPE "public"."loan_status" AS ENUM('active', 'repaid', 'expired', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'TRANSFER_DEBIT' BEFORE 'ALLOCATION_ADJUST';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'TRANSFER_CREDIT' BEFORE 'ALLOCATION_ADJUST';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'TRANSFER_FAILED' BEFORE 'ALLOCATION_ADJUST';--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lender_org_id" uuid NOT NULL,
	"borrower_org_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"note" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "loans_different_orgs_check" CHECK ("loans"."lender_org_id" != "loans"."borrower_org_id"),
	CONSTRAINT "loans_amount_check" CHECK ("loans"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_lender_org_id_organizations_id_fk" FOREIGN KEY ("lender_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_borrower_org_id_organizations_id_fk" FOREIGN KEY ("borrower_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_loans_lender_active" ON "loans" USING btree ("lender_org_id","created_at" DESC NULLS LAST) WHERE "loans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_loans_borrower_active" ON "loans" USING btree ("borrower_org_id","created_at" DESC NULLS LAST) WHERE "loans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_loans_expiry_scan" ON "loans" USING btree ("expires_at") WHERE "loans"."status" = 'active';--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
COMMIT;--> statement-breakpoint
CREATE INDEX "idx_quota_events_trading" ON "quota_events" USING btree ("org_id","created_at" DESC NULLS LAST) WHERE "quota_events"."event_type" IN ('TRANSFER_DEBIT', 'TRANSFER_CREDIT', 'TRANSFER_FAILED', 'LOAN_CREATE', 'LOAN_REPAY', 'LOAN_EXPIRE', 'LOAN_CANCEL');--> statement-breakpoint
BEGIN;