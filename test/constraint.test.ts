import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db';
import { quotaEvents, organizations } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('Data Integrity - balance_after Constraint', () => {
  let orgId: string;

  beforeAll(async () => {
    // We assume the DB is clean or we just create a new org
    const [org] = await db.insert(organizations).values({
      slug: `test-org-${Date.now()}`,
      name: 'Test Org for Constraints',
      quotaAllocated: 1000,
    }).returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    await db.delete(quotaEvents).where(eq(quotaEvents.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it('should allow inserting an event if balance_after >= 0', async () => {
    const [evt] = await db.insert(quotaEvents).values({
      orgId,
      eventType: 'ALLOCATION_ADJUST',
      amount: 500,
      balanceAfter: 500,
      idempotencyKey: randomUUID()
    }).returning();

    expect(evt).toBeDefined();
    expect(evt.balanceAfter).toBe(500);
  });

  it('should throw constraint error if balance_after < 0', async () => {
    await expect(
      db.insert(quotaEvents).values({
        orgId,
        eventType: 'ALLOCATION_ADJUST',
        amount: -500,
        balanceAfter: -100, // Invalid
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow(/Failed query/);
  });
});
