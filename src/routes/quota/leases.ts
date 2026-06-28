import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { leases } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { QuotaService, InsufficientQuotaError, NotFoundError } from '../../services/quota.service';

const leasesRoutes: FastifyPluginAsync = async (fastify) => {
  const quotaService = new QuotaService(fastify);

  fastify.post<{
    Body: { amount: number; ttlSeconds: number };
    Headers: { 'x-idempotency-key': string };
  }>('/leases', async (request, reply) => {
    const { orgId, serviceId } = request.auth;
    const { amount, ttlSeconds } = request.body;
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Missing X-Idempotency-Key header' });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'amount must be > 0' });
    }

    if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'ttlSeconds must be > 0' });
    }

    try {
      const lease = await quotaService.claimLease({
        orgId,
        serviceId,
        amount,
        ttlSeconds,
        idempotencyKey,
      });

      return reply.status(201).send({ data: lease });
    } catch (err: any) {
      if (err instanceof InsufficientQuotaError) {
        return reply.status(402).send({ error: 'INSUFFICIENT_QUOTA', message: 'Not enough quota available' });
      }
      throw err;
    }
  });

  fastify.delete<{
    Params: { id: string };
  }>('/leases/:id', async (request, reply) => {
    const { serviceId } = request.auth;
    const { id } = request.params;

    try {
      const lease = await quotaService.releaseLease({
        leaseId: id,
        serviceId,
      });

      // Issue #4 Fix & Design Plan logic:
      // If we returned successfully but the returned lease status is NOT active (i.e. we didn't just release it now)
      // wait, in quotaService.releaseLease, if it's not active, it returns existingLease without updating
      // We should check if existingLease.status !== 'active' from the returned object?
      // Actually, if it was already released/expired, returning 409 LEASE_ALREADY_RELEASED is requested.
      // But we just returned the lease from releaseLease. Wait, in quotaService, if existing.status !== 'active', it returns existing.
      // Let's modify the check: if the lease we got back has status !== 'active', wait, what if it WAS active and we JUST updated it to 'released'?
      // In that case, the returned lease from UPDATE will have status = 'released'.
      // So we can't just check `lease.status`. We need `releaseLease` to indicate if it was actually released or already released.
      // Or we can check if `lease.releasedAt` is old? No, `releaseLease` can throw `ALREADY_RELEASED`.
      // Let's rely on quotaService throwing an error. I'll need to update quota.service.ts to throw a specific error instead of returning existingLease.
      
      return reply.send({ data: lease });
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Lease not found' });
      }
      if (err.message === 'LEASE_ALREADY_RELEASED') {
        return reply.status(409).send({ error: 'LEASE_ALREADY_RELEASED', message: 'Lease is already released or expired' });
      }
      throw err;
    }
  });

  fastify.get('/leases', async (request, reply) => {
    const { serviceId } = request.auth;
    
    const serviceLeases = await db
      .select()
      .from(leases)
      .where(eq(leases.serviceId, serviceId))
      .limit(100);

    return reply.send({ data: serviceLeases });
  });

  fastify.get<{
    Params: { id: string };
  }>('/leases/:id', async (request, reply) => {
    const { serviceId } = request.auth;
    const { id } = request.params;

    const [lease] = await db
      .select()
      .from(leases)
      .where(and(eq(leases.id, id), eq(leases.serviceId, serviceId)))
      .limit(1);

    if (!lease) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Lease not found' });
    }

    return reply.send({ data: lease });
  });
};

export default leasesRoutes;
