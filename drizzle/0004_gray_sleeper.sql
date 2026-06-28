ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_counterpart_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_events" DROP CONSTRAINT "quota_events_lease_id_leases_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_counterpart_org_id_organizations_id_fk" FOREIGN KEY ("counterpart_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE restrict ON UPDATE no action;