import { pgTable, uuid, varchar, timestamp, boolean, integer, pgEnum, bigint, jsonb, index, check, text } from "drizzle-orm/pg-core";
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

export const loanStatusEnum = pgEnum('loan_status', ['active', 'repaid', 'expired', 'cancelled']);

export const quotaEventTypeEnum = pgEnum("quota_event_type", [
  'LEASE_CLAIM',
  'LEASE_RELEASE',
  'LEASE_EXPIRE',
  'LOAN_CREATE',
  'LOAN_REPAY',
  'LOAN_EXPIRE',
  'LOAN_CANCEL',
  'ALLOCATION_ADJUST',
  'RECONCILIATION_CORRECTION',
  'LEASE_CLAIM_FAILED',
  'LEASE_RELEASE_FAILED',
  'TRANSFER_DEBIT',
  'TRANSFER_CREDIT',
  'TRANSFER_FAILED',
  'LOAN_CREATE_FAILED',
  'LOAN_REPAY_FAILED',
  'LOAN_CANCEL_FAILED',
  'LOAN_EXPIRE_FAILED'
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
    amountPositiveCheck: check('leases_amount_check', sql`${table.amount} > 0`),
  };
});

export const loans = pgTable("loans", {
  id: uuid("id").primaryKey().defaultRandom(),
  lenderOrgId: uuid("lender_org_id").notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  borrowerOrgId: uuid("borrower_org_id").notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  amount: bigint("amount", { mode: 'number' }).notNull(),
  status: loanStatusEnum("status").notNull().default('active'),
  note: text('note'),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
  return {
    lenderActiveIdx: index("idx_loans_lender_active").on(table.lenderOrgId, table.createdAt.desc()).where(sql`${table.status} = 'active'`),
    borrowerActiveIdx: index("idx_loans_borrower_active").on(table.borrowerOrgId, table.createdAt.desc()).where(sql`${table.status} = 'active'`),
    expiryScanIdx: index("idx_loans_expiry_scan").on(table.expiresAt).where(sql`${table.status} = 'active'`),
    differentOrgsCheck: check('loans_different_orgs_check', sql`${table.lenderOrgId} != ${table.borrowerOrgId}`),
    amountPositiveCheck: check('loans_amount_check', sql`${table.amount} > 0`),
    expiresAfterCreated: check("loans_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`)
  };
});

export const quotaEvents = pgTable("quota_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: quotaEventTypeEnum("event_type").notNull(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  counterpartOrgId: uuid("counterpart_org_id").references(() => organizations.id, { onDelete: 'restrict' }),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: 'restrict' }),
  leaseId: uuid("lease_id").references(() => leases.id, { onDelete: 'restrict' }),
  loanId: uuid("loan_id").references(() => loans.id, { onDelete: 'restrict' }),
  amount: bigint("amount", { mode: 'number' }).notNull(),
  balanceAfter: bigint("balance_after", { mode: 'number' }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).unique(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => {
  return {
    orgTimeIdx: index("idx_quota_events_org_time").on(table.orgId, table.createdAt.desc()),
    tradingEventsIdx: index("idx_quota_events_trading")
      .on(table.orgId, table.createdAt.desc())
      .where(sql`${table.eventType} IN ('TRANSFER_DEBIT', 'TRANSFER_CREDIT', 'TRANSFER_FAILED', 'LOAN_CREATE', 'LOAN_REPAY', 'LOAN_EXPIRE', 'LOAN_CANCEL')`),
    amountPositiveCheck: check('quota_events_amount_check', sql`${table.amount} > 0`),
    balancePositiveCheck: check('quota_events_balance_check', sql`${table.balanceAfter} >= 0`)
  };
});
