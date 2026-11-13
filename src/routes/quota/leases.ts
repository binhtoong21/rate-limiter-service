import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { leases } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { QuotaService, InsufficientQuotaError, NotFoundError } from '../../services/quota.service';

const leaseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orgId: { type: 'string', format: 'uuid' },
    serviceId: { type: 'string', format: 'uuid' },
    amount: { type: 'integer', example: 500 },
    status: { type: 'string', enum: ['active', 'released', 'expired'], example: 'active' },
    claimedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    releasedAt: { type: ['string', 'null'], format: 'date-time', nullable: true },
  },
  required: ['id', 'orgId', 'serviceId', 'amount', 'status', 'claimedAt', 'expiresAt'],
  additionalProperties: true,
};

const leasesRoutes: FastifyPluginAsync = async (fastify) => {
  const quotaService = new QuotaService(fastify);

  fastify.post<{
    Body: { amount: number; ttlSeconds: number };
    Headers: { 'x-idempotency-key': string };
  }>('/leases', {
    schema: {
      tags: ['Leases'],
      summary: 'Claim a dynamic quota lease',
      description: 'Claims a temporary quota lease from the organization pool for a specified TTL in seconds. Decrements available quota and creates an active lease.',
      security: [{ ApiKeyAuth: [] }],
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': { type: 'string', description: 'Unique idempotency key' },
        },
        required: ['x-idempotency-key'],
      },
      body: {
        type: 'object',
        required: ['amount', 'ttlSeconds'],
        properties: {
          amount: { type: 'integer', minimum: 1, description: 'Lease quota amount' },
          ttlSeconds: { type: 'integer', minimum: 1, description: 'Lease time-to-live in seconds' },
        },
      },
      response: {
        201: {
          description: 'Lease created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: leaseSchema,
          },
          required: ['success', 'data'],
        },
        400: {
          description: 'Validation error',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'BAD_REQUEST' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'MISSING_API_KEY' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        422: {
          description: 'Insufficient quota available',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INSUFFICIENT_QUOTA' },
                message: { type: 'string', example: 'Not enough quota available' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    const { orgId, serviceId } = request.auth;
    const { amount, ttlSeconds } = request.body;
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'Missing X-Idempotency-Key header' } });
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'amount must be a positive integer' } });
    }

    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      return reply.status(400).send({ success: false, error: { code: 'BAD_REQUEST', message: 'ttlSeconds must be a positive integer' } });
    }

    try {
      const lease = await quotaService.claimLease({
        orgId,
        serviceId,
        amount,
        ttlSeconds,
        idempotencyKey,
      });

      return reply.status(201).send({ success: true, data: lease });
    } catch (err: any) {
      if (err instanceof InsufficientQuotaError) {
        return reply.status(422).send({ success: false, error: { code: 'INSUFFICIENT_QUOTA', message: 'Not enough quota available' } });
      }
      throw err;
    }
  });

  fastify.delete<{
    Params: { id: string };
  }>('/leases/:id', {
    schema: {
      tags: ['Leases'],
      summary: 'Release an active quota lease',
      description: 'Early-releases an active lease and returns the reserved quota back to the available pool.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Lease UUID' },
        },
      },
      response: {
        200: {
          description: 'Lease released successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: leaseSchema,
          },
          required: ['success', 'data'],
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'MISSING_API_KEY' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Lease not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Lease not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        409: {
          description: 'Lease already released or expired',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'LEASE_ALREADY_RELEASED' },
                message: { type: 'string', example: 'Lease is already released or expired' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    const { serviceId } = request.auth;
    const { id } = request.params;

    try {
      const lease = await quotaService.releaseLease({
        leaseId: id,
        serviceId,
      });

      return reply.send({ success: true, data: lease });
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Lease not found' } });
      }
      if (err.message === 'LEASE_ALREADY_RELEASED') {
        return reply.status(409).send({ success: false, error: { code: 'LEASE_ALREADY_RELEASED', message: 'Lease is already released or expired' } });
      }
      throw err;
    }
  });

  fastify.get('/leases', {
    schema: {
      tags: ['Leases'],
      summary: 'List quota leases for service',
      description: 'Lists up to 100 recent quota leases created by the authenticated service.',
      security: [{ ApiKeyAuth: [] }],
      response: {
        200: {
          description: 'List of leases',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'array',
              items: leaseSchema,
            },
          },
          required: ['success', 'data'],
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'MISSING_API_KEY' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    const { serviceId } = request.auth;
    
    const serviceLeases = await db
      .select()
      .from(leases)
      .where(eq(leases.serviceId, serviceId))
      .limit(100);

    return reply.send({ success: true, data: serviceLeases });
  });

  fastify.get<{
    Params: { id: string };
  }>('/leases/:id', {
    schema: {
      tags: ['Leases'],
      summary: 'Get quota lease by ID',
      description: 'Retrieves details for a specific quota lease owned by the calling service.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Lease UUID' },
        },
      },
      response: {
        200: {
          description: 'Lease details',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: leaseSchema,
          },
          required: ['success', 'data'],
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'MISSING_API_KEY' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Lease not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Lease not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    const { serviceId } = request.auth;
    const { id } = request.params;

    const [lease] = await db
      .select()
      .from(leases)
      .where(and(eq(leases.id, id), eq(leases.serviceId, serviceId)))
      .limit(1);

    if (!lease) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Lease not found' } });
    }

    return reply.send({ success: true, data: lease });
  });
};

export default leasesRoutes;
