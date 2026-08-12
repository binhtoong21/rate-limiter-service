import { describe, it, expect } from 'vitest';
import { db } from '../src/db';
import { quotaEvents, organizations } from '../src/db/schema';
import { randomUUID } from 'crypto';

describe('Data Integrity - balance_after Constraint', () => {
  it('should run full fixture in an isolated rollback transaction', async () => {
    // We execute the whole suite logic inside a transaction and rollback at the end
    await expect(
      db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({
          slug: `test-org-${Date.now()}`,
          name: 'Test Org for Constraints',
          quotaAllocated: 1000,
        }).returning({ id: organizations.id });
        const orgId = org.id;

        // 1. Valid insert
        const [evt] = await tx.insert(quotaEvents).values({
          orgId,
          eventType: 'ALLOCATION_ADJUST',
          amount: 500,
          balanceAfter: 500,
          idempotencyKey: randomUUID()
        }).returning();

        expect(evt).toBeDefined();
        expect(evt.balanceAfter).toBe(500);

        // 2. Invalid insert (< 0 balance)
        await tx.insert(quotaEvents).values({
          orgId,
          eventType: 'ALLOCATION_ADJUST',
          amount: 500,
          balanceAfter: -100, // Invalid balance_after
          idempotencyKey: randomUUID()
        });

        // If it reaches here without error, the test fails
      })
    ).rejects.toThrow(/Failed query/);
  });
});
