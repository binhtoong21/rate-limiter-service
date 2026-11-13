import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { db } from '../db';
import { leases, quotaEvents, organizations } from '../db/schema';
import { FastifyInstance } from 'fastify';
import { enforceDeficit } from '../services/deficit.service';
import { eq, and, lt, sql } from 'drizzle-orm';
import { redis as defaultRedis } from '../redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const startLeaseExpiryWorker = async () => {
  // BullMQ requires maxRetriesPerRequest: null
  const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });

  const leaseExpiryQueue = new Queue('lease-expiry', { connection: connection as any });

  const leaseExpiryWorker = new Worker('lease-expiry', async (job) => {
  // 1. SELECT expired leases (status='active' AND expires_at < NOW()) LIMIT 100
  const expiredLeases = await db
    .select()
    .from(leases)
    .where(and(eq(leases.status, 'active'), lt(leases.expiresAt, sql`${new Date().toISOString()}::timestamptz`)))
    .limit(100);


  let processed = 0;

  // 2. For each:
  for (const lease of expiredLeases) {
    try {
      // b. db.transaction (with row-level lock)
      await db.transaction(async (tx) => {
        // Lock org
        await tx.execute(sql`SELECT id FROM organizations WHERE id = ${lease.orgId} FOR UPDATE`);

        // a. GET available (synchronized)
        const poolAvailableStr = await defaultRedis.get(`quota:pool:${lease.orgId}:available`);
        const available = parseInt(poolAvailableStr || '0', 10);
        const balanceAfter = available + lease.amount;

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
        const status = await defaultRedis.releaseLease(
          `quota:pool:${lease.orgId}:available`,
          `quota:pool:${lease.orgId}:reserved`,
          `quota:lease:${lease.id}`,
          `quota:lease:active:${lease.orgId}`,
          `quota:lease:active_sum:${lease.orgId}`,
          lease.id,
          lease.amount.toString()
        );
        
        if (status === 'OK_UNDERFLOW') {
          logger.warn({ orgId: lease.orgId, leaseId: lease.id }, 'Lease active_sum underflow detected during expiry');
        }
      });
      processed++;
    } catch (err) {
      logger.error({ err, leaseId: lease.id }, 'Failed to process expired lease');
    }
  }

  // Deficit enforcement: borrowers left below zero by a loan recall or expiry
  const orgRows = await db.select({ id: organizations.id }).from(organizations);
  const logFacade = { log: logger } as unknown as FastifyInstance;
  for (const o of orgRows) {
    try {
      const r = await enforceDeficit(logFacade, o.id);
      if (r.revokedLeaseIds.length > 0) {
        logger.warn({ orgId: o.id, revoked: r.revokedLeaseIds, deficitLeft: r.deficit }, 'Revoked leases to cover a quota deficit');
      }
    } catch (err) {
      logger.error({ err, orgId: o.id }, 'Deficit enforcement failed');
    }
  }

  if (processed > 0) {
    logger.info(`Processed ${processed} expired leases in batch`);
  }

  return { processed };
}, { connection: connection as any });

  leaseExpiryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Lease expiry job failed');
  });

  // Setup repeatable job every 30 seconds
  await leaseExpiryQueue.add('scan-expired', {}, {
    repeat: {
      every: 30000,
    }
  });
};
