import { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { organizations, quotaEvents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { redis } from '../redis';

const orgsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch<{
    Params: { slug: string };
    Body: { amount: number };
  }>('/:slug/quota', async (request, reply) => {
    // Admin only guard
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ error: 'FORBIDDEN', message: 'Admin access required' });
    }

    const { slug } = request.params;
    const { amount } = request.body;

    if (typeof amount !== 'number' || amount < 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Amount must be a non-negative number' });
    }

    // Find org by slug
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (!org) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Organization not found' });
    }

    let returnedAmount: string = "0";

    await db.transaction(async (tx) => {
      // 1. Update PG quotaAllocated
      await tx.update(organizations)
        .set({ quotaAllocated: amount })
        .where(eq(organizations.id, org.id));

      // 2. Insert event
      await tx.insert(quotaEvents).values({
        eventType: 'ALLOCATION_ADJUST',
        orgId: org.id,
        amount,
        balanceAfter: amount, // Approximated. Real balance will be set in redis
      });
    });

    // 3. Redis Lua to update pool atomically (total & available)
    // Execute after PG commit so we don't end up with Redis updated but PG rollbacked
    returnedAmount = await redis.setQuotaPool(
      `quota:pool:${org.id}:total`,
      `quota:pool:${org.id}:available`,
      `quota:pool:${org.id}:reserved`,
      amount.toString()
    );

    return reply.send({ data: { quotaAllocated: amount, available: parseInt(returnedAmount, 10) } });
  });
};

export default orgsRoutes;
