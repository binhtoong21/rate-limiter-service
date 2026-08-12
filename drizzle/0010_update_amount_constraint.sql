COMMIT;--> statement-breakpoint
ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_amount_check";--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_amount_check" CHECK (("quota_events"."amount" > 0) OR ("quota_events"."amount" = 0 AND "quota_events"."event_type" IN ('ALLOCATION_ADJUST', 'ALLOCATION_ADJUST_FAILED')));--> statement-breakpoint
BEGIN;
