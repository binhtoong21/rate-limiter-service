ALTER TABLE "leases" DROP CONSTRAINT "leases_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "leases" DROP CONSTRAINT "leases_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;