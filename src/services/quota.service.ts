import { db } from '../db';
import { leases, quotaEvents } from '../db/schema';
import { redis } from '../redis';
import { idempotencyService } from './idempotency.service';
import { eq, and } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';

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
    const { orgId, serviceId, amount, ttlSeconds, idempotencyKey } = params;

    // Step 1: Idempotency check (Redis)
    const { exists, cachedResult } = await idempotencyService.check(idempotencyKey);
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
    }

    // Step 2: Tính balance_after (best-effort estimate)
    const poolAvailableStr = await redis.get(`quota:pool:${orgId}:available`);
    const available = parseInt(poolAvailableStr || '0', 10);
    const balanceAfter = available - amount;

    if (balanceAfter < 0) {
      throw new InsufficientQuotaError();
    }

    let createdLeaseId: string | undefined;
    let createdEventId: string | undefined;
    let returnedLease: typeof leases.$inferSelect | undefined;

    // Step 3: Atomic Unit (PG tx + Lua)
    try {
      await db.transaction(async (tx) => {
        // 3A: PostgreSQL INSERT
        const [newLease] = await tx
          .insert(leases)
          .values({
            orgId,
            serviceId,
            amount,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
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
            newLease.expiresAt.getTime().toString(),
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
      
      // PostgreSQL unique violation error code is 23505
      if (err.code === '23505' && err.constraint === 'quota_events_idempotency_key_unique') {
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
      await idempotencyService.mark(idempotencyKey, createdEventId);
    }

    return returnedLease!;
  }

  async releaseLease(params: {
    leaseId: string;
    serviceId: string;
  }): Promise<typeof leases.$inferSelect> {
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

    // Step 2: Tính balance_after (best-effort)
    const poolAvailableStr = await redis.get(`quota:pool:${existingLease.orgId}:available`);
    const available = parseInt(poolAvailableStr || '0', 10);
    const balanceAfter = available + existingLease.amount;

    let returnedLease: typeof leases.$inferSelect | undefined;

    // Step 3: Atomic Unit (PG tx + Lua)
    await db.transaction(async (tx) => {
      // 3A: Update PG
      const [updatedLease] = await tx
        .update(leases)
        .set({
          status: 'released',
          releasedAt: new Date(),
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
        leaseId
      );
    });

    return returnedLease!;
  }
}
