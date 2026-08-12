ALTER TYPE "public"."quota_event_type" ADD VALUE 'ALLOCATION_ADJUST_FAILED' BEFORE 'RECONCILIATION_CORRECTION';--> statement-breakpoint
ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_amount_check";--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_amount_check" CHECK ("quota_events"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_balance_check" CHECK ("quota_events"."balance_after" >= 0);