ALTER TYPE "public"."quota_event_type" ADD VALUE 'LEASE_CLAIM_FAILED';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'LEASE_RELEASE_FAILED';--> statement-breakpoint

ALTER TYPE "public"."quota_event_type" ADD VALUE 'LOAN_CREATE_FAILED';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'LOAN_REPAY_FAILED';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'LOAN_CANCEL_FAILED';--> statement-breakpoint
ALTER TYPE "public"."quota_event_type" ADD VALUE 'LOAN_EXPIRE_FAILED';