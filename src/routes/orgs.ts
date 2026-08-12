import { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { organizations, quotaEvents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { redis } from '../redis';
import { idempotencyService } from '../services/idempotency.service';

const orgsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch<{
    Params: { slug: string };
    Body: { amount: number };
    Headers: { 'x-idempotency-key'?: string };
  }>('/:slug/quota', async (request, reply) => {
    // Admin only guard
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { slug } = request.params;
    const { amount } = request.body;

    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'Amount must be a non-negative safe integer' } });
    }

    const idempotencyKey = request.headers['x-idempotency-key'] as string | undefined;
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'Missing or empty X-Idempotency-Key header' } });
    }

    // Find org by slug
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (!org) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    }

    let fingerprint: string | undefined;
    if (idempotencyKey) {
      fingerprint = `${org.id}:${amount}:ALLOCATION_ADJUST`;
      try {
        const { exists, cachedResult } = await idempotencyService.check(idempotencyKey, fingerprint);
        if (exists) {
          // If already adjusted, we return the cached pool data but we must read the live available amount
          // because it might have changed since the event.
          // However, for pure idempotency, returning the total from the cached event is correct.
          const currentAvailable = await redis.get(`quota:pool:${org.id}:available`);
          return reply.send({ success: true, data: { quotaAllocated: cachedResult.amount, available: parseInt(currentAvailable || '0', 10) } });
        }
      } catch (err: any) {
        if (err.message === 'DUPLICATE_IDEMPOTENCY_KEY') {
          return reply.status(409).send({ success: false, error: { code: 'DUPLICATE_IDEMPOTENCY_KEY', message: 'Idempotency key already used for a different request' } });
        }
        throw err;
      }
    }

    const reservedRaw = await redis.get(`quota:pool:${org.id}:reserved`);
    const loanedOutRaw = await redis.get(`quota:pool:${org.id}:loaned_out`);
    const receivedRaw = await redis.get(`quota:pool:${org.id}:received`);
    const reserved = parseInt(reservedRaw || '0', 10);
    const loanedOut = parseInt(loanedOutRaw || '0', 10);
    const received = parseInt(receivedRaw || '0', 10);
    const balanceAfterEstimate = amount - reserved - loanedOut + received;

    if (balanceAfterEstimate < 0) {
      return reply.status(422).send({ success: false, error: { code: 'ALLOCATION_BELOW_COMMITTED_QUOTA', message: 'Allocation update would make available quota negative' } });
    }

    let returnedAmount: string = "0";
    let eventRecordId: string | undefined;

    try {
      await db.transaction(async (tx) => {
        // 1. Update PG quotaAllocated
        await tx.update(organizations)
          .set({ quotaAllocated: amount })
          .where(eq(organizations.id, org.id));

        // 2. Insert event
        const [evt] = await tx.insert(quotaEvents).values({
          eventType: 'ALLOCATION_ADJUST',
          orgId: org.id,
          amount,
          balanceAfter: balanceAfterEstimate, // Best-effort estimate: reserved read before setQuotaPool call
          idempotencyKey,
        }).returning({ id: quotaEvents.id });
        eventRecordId = evt.id;
      });
    } catch (err: any) {
      if (err.code === '23505' && idempotencyKey) {
        const event = await idempotencyService.handleUniqueViolation(idempotencyKey);
        const currentAvailable = await redis.get(`quota:pool:${org.id}:available`);
        return reply.send({ success: true, data: { quotaAllocated: event.amount, available: parseInt(currentAvailable || '0', 10) } });
      }
      throw err;
    }

    // 3. Redis Lua to update pool atomically (total & available)
    // Execute after PG commit so we don't end up with Redis updated but PG rollbacked
    try {
      returnedAmount = await redis.setQuotaPool(
        `quota:pool:${org.id}:total`,
        `quota:pool:${org.id}:available`,
        `quota:pool:${org.id}:reserved`,
        `quota:pool:${org.id}:loaned_out`,
        `quota:pool:${org.id}:received`,
        amount.toString()
      );
    } catch (err: any) {
      await db.insert(quotaEvents).values({
        eventType: 'ALLOCATION_ADJUST_FAILED',
        orgId: org.id,
        amount,
        balanceAfter: balanceAfterEstimate,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:fail` : undefined
      });
      if (err.message && err.message.includes('RESERVED_EXCEEDS_TOTAL')) {
        return reply.status(422).send({ success: false, error: { code: 'ALLOCATION_BELOW_COMMITTED_QUOTA', message: 'Allocation update would make available quota negative (rejected by Lua)' } });
      }
      throw err;
    }

    if (idempotencyKey && eventRecordId) {
      await idempotencyService.mark(idempotencyKey, eventRecordId, fingerprint);
    }

    return reply.send({ success: true, data: { quotaAllocated: amount, available: parseInt(returnedAmount, 10) } });
  });

  fastify.get<{
    Params: { slug: string };
  }>('/:slug/quota/pool', async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { slug } = request.params;

    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (!org) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    }

    const pipeline = redis.pipeline();
    pipeline.get(`quota:pool:${org.id}:total`);
    pipeline.get(`quota:pool:${org.id}:reserved`);
    pipeline.get(`quota:pool:${org.id}:loaned_out`);
    pipeline.get(`quota:pool:${org.id}:received`);
    pipeline.get(`quota:pool:${org.id}:available`);

    const results = await pipeline.exec();

    if (!results) {
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redis pipeline failed' } });
    }

    const [totalErr, totalRes] = results[0];
    const [reservedErr, reservedRes] = results[1];
    const [loanedOutErr, loanedOutRes] = results[2];
    const [receivedErr, receivedRes] = results[3];
    const [availableErr, availableRes] = results[4];

    if (totalErr || reservedErr || loanedOutErr || receivedErr || availableErr) {
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redis read error' } });
    }

    return reply.send({ success: true, data: {
        orgId: org.id,
        slug: org.slug,
        pool: {
          total: parseInt((totalRes as string) || '0', 10),
          reserved: parseInt((reservedRes as string) || '0', 10),
          loanedOut: parseInt((loanedOutRes as string) || '0', 10),
          received: parseInt((receivedRes as string) || '0', 10),
          available: parseInt((availableRes as string) || '0', 10),
        },
      },
    });
  });
};

export default orgsRoutes;
