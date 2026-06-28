import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { db } from '../db';
import { leases, quotaEvents } from '../db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { redis as defaultRedis } from '../redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// BullMQ requires maxRetriesPerRequest: null
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const leaseExpiryQueue = new Queue('lease-expiry', { connection });

export const leaseExpiryWorker = new Worker('lease-expiry', async (job) => {
  // 1. SELECT expired leases (status='active' AND expires_at < NOW()) LIMIT 100
  const expiredLeases = await db
    .select()
    .from(leases)
    .where(and(eq(leases.status, 'active'), lt(leases.expiresAt, new Date())))
    .limit(100);

  if (expiredLeases.length === 0) {
    return { processed: 0 };
  }

  let processed = 0;

  // 2. For each:
  for (const lease of expiredLeases) {
    try {
      // a. GET available (best effort) → balance_after
      // ⚠️ Cùng trade-off với service layer: GET ngoài transaction, balance_after là estimate.
      const poolAvailableStr = await defaultRedis.get(`quota:pool:${lease.orgId}:available`);
      const available = parseInt(poolAvailableStr || '0', 10);
      const balanceAfter = available + lease.amount;

      // b. db.transaction
      await db.transaction(async (tx) => {
        const [updatedLease] = await tx
          .update(leases)
          .set({ status: 'expired' })
          .where(and(eq(leases.id, lease.id), eq(leases.status, 'active')))
          .returning();

        if (!updatedLease) {
          // Has been released or expired concurrently (prevent double)
          return;
        }

        await tx.insert(quotaEvents).values({
          eventType: 'LEASE_EXPIRE',
          orgId: lease.orgId,
          serviceId: lease.serviceId,
          leaseId: lease.id,
          amount: lease.amount,
          balanceAfter,
        });

        // EVALSHA release_lease.lua
        // ⚠️ Redis Lua không tham gia PG transaction, crash recovery applies.
        await defaultRedis.releaseLease(
          `quota:pool:${lease.orgId}:available`,
          `quota:pool:${lease.orgId}:reserved`,
          `quota:lease:${lease.id}`,
          `quota:lease:active:${lease.orgId}`,
          lease.id
        );

        processed++;
      });
    } catch (err) {
      logger.error({ err, leaseId: lease.id }, 'Failed to process expired lease');
    }
  }

  if (processed > 0) {
    logger.info(`Processed ${processed} expired leases in batch`);
  }

  return { processed };
}, { connection });

leaseExpiryWorker.on('failed', (job, err) => {
  logger.error({ err, jobId: job?.id }, 'Lease expiry job failed');
});

// Setup repeatable job every 30 seconds
leaseExpiryQueue.add('scan-expired', {}, {
  repeat: {
    every: 30000,
  }
});
