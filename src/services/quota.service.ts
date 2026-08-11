import { db } from '../db';
import { leases, quotaEvents } from '../db/schema';
import { redis } from '../redis';
import { idempotencyService } from './idempotency.service';
import { eq, and, sql } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';
import { quotaOperationTotal, quotaOperationDuration } from '../plugins/metrics';

export class InsufficientQuotaError extends Error {
  constructor(message = 'Insufficient quota') {
    super(message);
    this.name = 'InsufficientQuotaError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class QuotaService {
  constructor(private fastify: FastifyInstance) {}

  async claimLease(params: {
    orgId: string;
    serviceId: string;
    amount: number;
    ttlSeconds: number;
    idempotencyKey: string;
  }): Promise<typeof leases.$inferSelect> {
    const timer = quotaOperationDuration.startTimer({ type: 'claim_lease' });
    try {
      const { orgId, serviceId, amount, ttlSeconds, idempotencyKey } = params;

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive integer');
    }

    const fingerprint = `${orgId}:${serviceId}:${amount}:CLAIM`;

    // Step 1: Idempotency check (Redis)
    const { exists, cachedResult } = await idempotencyService.check(idempotencyKey, fingerprint);
    if (exists && cachedResult) {
      // If we got a hit in Redis, return the cached result.
      // We need to fetch the actual lease object since the event just has the ID.
      if (cachedResult.leaseId) {
        const [existingLease] = await db
          .select()
          .from(leases)
          .where(eq(leases.id, cachedResult.leaseId))
          .limit(1);
        if (existingLease) {
          return existingLease;
        }
      }
      throw new Error('Idempotency collision but lease not found');
    }

    let createdLeaseId: string | undefined;
    let createdEventId: string | undefined;
    let returnedLease: typeof leases.$inferSelect | undefined;

    // Step 2 & 3: Atomic Unit (PG tx + Lua)
    try {
      await db.transaction(async (tx) => {
        // 2A: Row-level lock on the organization to serialize concurrent requests
        // Trade-off: This lock is held across the Redis Lua execution network trip.
        // This causes potential lock contention for high-traffic orgs, but is required
        // to ensure balanceAfter correctness without violating the dual-write order.
        await tx.execute(sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`);

        // 2B: Tính balance_after (now fully synchronized per org)
        const poolAvailableStr = await redis.get(`quota:pool:${orgId}:available`);
        const available = parseInt(poolAvailableStr || '0', 10);
        const balanceAfter = available - amount;

        if (balanceAfter < 0) {
          throw new InsufficientQuotaError();
        }

        // 3A: PostgreSQL INSERT
        const [newLease] = await tx
          .insert(leases)
          .values({
            orgId,
            serviceId,
            amount,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
            status: 'active',
          })
          .returning();
          
        createdLeaseId = newLease.id;
        returnedLease = newLease;

        const [newEvent] = await tx
          .insert(quotaEvents)
          .values({
            eventType: 'LEASE_CLAIM',
            orgId,
            serviceId,
            leaseId: newLease.id,
            amount,
            balanceAfter,
            idempotencyKey,
          })
          .returning();
          
        createdEventId = newEvent.id;

        // 3B: Redis Lua
        // ⚠️ Redis Lua không tham gia PG transaction.
        // Nếu PG commit fail sau Lua thành công → Redis state deducted, PG không có record.
        // Reconciliation worker sẽ detect và correct divergence.
        // Xem: adr-001-eventual-consistency.md
        
        try {
          await redis.claimLease(
            `quota:pool:${orgId}:available`,
            `quota:pool:${orgId}:reserved`,
            `quota:lease:${newLease.id}`,
            `quota:lease:active:${orgId}`,
            newLease.id,
            orgId,
            serviceId,
            amount.toString(),
            new Date(newLease.expiresAt).getTime().toString(),
            ttlSeconds.toString()
          );
        } catch (luaErr: any) {
          if (luaErr.message && luaErr.message.includes('INSUFFICIENT_QUOTA')) {
            throw new InsufficientQuotaError();
          }
          throw luaErr;
        }
        
        // 3C: Commit ngầm định nếu không có lỗi
      });
    } catch (err: any) {
      if (err instanceof InsufficientQuotaError) {
        // Transaction ĐÃ BỊ ROLLBACK ở đây. Không có false LEASE_CLAIM trong DB.
        throw err;
      }
      
      // PostgreSQL unique violation error constraint_name (porsager driver)
      if (err.code === '23505' && err.constraint_name === 'quota_events_idempotency_key_unique') {
        // ⚠️ Issue #4: Handle crash recovery for idempotency key
        // Transaction hiện tại đã bị aborted. Ta dùng connection mới để query:
        const existingEvent = await idempotencyService.handleUniqueViolation(idempotencyKey);
        
        if (existingEvent.leaseId) {
          const [existingLease] = await db
            .select()
            .from(leases)
            .where(eq(leases.id, existingEvent.leaseId))
            .limit(1);
            
          if (existingLease) {
            return existingLease;
          }
        }
        throw new Error('Idempotency collision but lease not found');
      }
      
      throw err;
    }

    // Step 4: Set idempotency key
    if (createdEventId) {
      await idempotencyService.mark(idempotencyKey, createdEventId, fingerprint);
    }

    quotaOperationTotal.inc({ type: 'claim_lease', status: 'success' });
    timer();
    return returnedLease!;
  } catch (err) {
    quotaOperationTotal.inc({ type: 'claim_lease', status: 'failure' });
    timer();
    throw err;
  }
}

  async releaseLease(params: {
    leaseId: string;
    serviceId: string;
  }): Promise<typeof leases.$inferSelect> {
    const timer = quotaOperationDuration.startTimer({ type: 'release_lease' });
    try {
      const { leaseId, serviceId } = params;

    // Step 1: Query existing lease
    const [existingLease] = await db
      .select()
      .from(leases)
      .where(and(eq(leases.id, leaseId), eq(leases.serviceId, serviceId)))
      .limit(1);

    if (!existingLease) {
      throw new NotFoundError('Lease not found');
    }

    if (existingLease.status !== 'active') {
      throw new Error('LEASE_ALREADY_RELEASED');
    }

    let returnedLease: typeof leases.$inferSelect | undefined;

    // Step 2 & 3: Atomic Unit (PG tx + Lua)
    await db.transaction(async (tx) => {
      // Lock org
      await tx.execute(sql`SELECT id FROM organizations WHERE id = ${existingLease.orgId} FOR UPDATE`);

      // 2A: Tính balance_after (synchronized)
      const poolAvailableStr = await redis.get(`quota:pool:${existingLease.orgId}:available`);
      const available = parseInt(poolAvailableStr || '0', 10);
      const balanceAfter = available + existingLease.amount;

      // 3A: Update PG
      const [updatedLease] = await tx
        .update(leases)
        .set({
          status: 'released',
          releasedAt: new Date().toISOString(),
        })
        .where(and(eq(leases.id, leaseId), eq(leases.status, 'active')))
        .returning();

      if (!updatedLease) {
        throw new Error('RACE_CONDITION');
      }

      returnedLease = updatedLease;

      await tx.insert(quotaEvents).values({
        eventType: 'LEASE_RELEASE',
        orgId: existingLease.orgId,
        serviceId,
        leaseId,
        amount: existingLease.amount,
        balanceAfter,
      });

      // 3B: Redis Lua
      await redis.releaseLease(
        `quota:pool:${existingLease.orgId}:available`,
        `quota:pool:${existingLease.orgId}:reserved`,
        `quota:lease:${leaseId}`,
        `quota:lease:active:${existingLease.orgId}`,
        leaseId,
        existingLease.amount.toString()
      );
    });

    quotaOperationTotal.inc({ type: 'release_lease', status: 'success' });
    timer();
    return returnedLease!;
  } catch (err) {
    quotaOperationTotal.inc({ type: 'release_lease', status: 'failure' });
    timer();
    throw err;
  }
}
}
