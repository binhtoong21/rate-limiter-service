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

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'amount must be a positive integer' });
    }

    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'ttlSeconds must be a positive integer' });
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
        return reply.status(422).send({ error: 'INSUFFICIENT_QUOTA', message: 'Not enough quota available' });
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
