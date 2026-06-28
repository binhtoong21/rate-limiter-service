ALTER TABLE "leases" ADD CONSTRAINT "leases_amount_check" CHECK ("leases"."amount" > 0);--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_amount_check" CHECK ("quota_events"."amount" > 0);--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_balance_check" CHECK ("quota_events"."balance_after" >= 0);