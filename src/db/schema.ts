import { pgTable, uuid, varchar, timestamp, boolean, integer, pgEnum, bigint, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  quotaAllocated: integer("quota_allocated").notNull().default(0),
  failOpen: boolean("fail_open").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  name: varchar("name", { length: 255 }).notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: 'cascade' }),
  keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
  keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('active'), // 'active', 'revoked'
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const leaseStatusEnum = pgEnum('lease_status', ['active', 'released', 'expired']);

export const quotaEventTypeEnum = pgEnum('quota_event_type', [
  'LEASE_CLAIM', 'LEASE_RELEASE', 'LEASE_EXPIRE',
  'LOAN_CREATE', 'LOAN_REPAY', 'LOAN_EXPIRE', 'LOAN_CANCEL',
  'ALLOCATION_ADJUST', 'RECONCILIATION_CORRECTION',
]);

export const leases = pgTable("leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'restrict' }),
  amount: bigint("amount", { mode: 'number' }).notNull(),
  status: leaseStatusEnum("status").notNull().default('active'),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
  return {
    activeByServiceIdx: index("idx_leases_active_by_service").on(table.serviceId, table.expiresAt).where(sql`${table.status} = 'active'`),
    expiryScanIdx: index("idx_leases_expiry_scan").on(table.expiresAt).where(sql`${table.status} = 'active'`),
  };
});

export const quotaEvents = pgTable("quota_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: quotaEventTypeEnum("event_type").notNull(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  counterpartOrgId: uuid("counterpart_org_id").references(() => organizations.id, { onDelete: 'set null' }),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: 'set null' }),
  leaseId: uuid("lease_id").references(() => leases.id, { onDelete: 'set null' }),
  loanId: uuid("loan_id"), // FK to loans table (to be created in Phase 3)
  amount: bigint("amount", { mode: 'number' }).notNull(),
  balanceAfter: bigint("balance_after", { mode: 'number' }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).unique(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => {
  return {
    orgTimeIdx: index("idx_quota_events_org_time").on(table.orgId, table.createdAt.desc()),
  };
});
