import { FastifyPluginAsync } from 'fastify';
import { db } from '../db';
import { organizations, quotaEvents } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { redis } from '../redis';
import { idempotencyService } from '../services/idempotency.service';

const orgsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch<{
    Params: { slug: string };
    Body: { amount: number };
    Headers: { 'x-idempotency-key'?: string };
  }>('/:slug/quota', {
    schema: {
      tags: ['Orgs'],
      summary: 'Adjust organization quota allocation',
      description: 'Admin-only endpoint to set the total allocated quota for an organization. Atomically updates PostgreSQL and Redis.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: 'Organization slug identifier' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': { type: 'string', description: 'Unique idempotency key' },
        },
        required: ['x-idempotency-key'],
      },
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'integer', minimum: 0, description: 'New quota allocation amount' },
        },
      },
      response: {
        200: {
          description: 'Quota allocation updated successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                quotaAllocated: { type: 'integer', example: 10000 },
                available: { type: 'integer', example: 10000 },
              },
              required: ['quotaAllocated', 'available'],
            },
          },
          required: ['success', 'data'],
        },
        400: {
          description: 'Validation error or invalid input',
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
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Organization not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Organization not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        409: {
          description: 'Duplicate idempotency key conflict',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'DUPLICATE_IDEMPOTENCY_KEY' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        422: {
          description: 'Allocation update would make available quota negative',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'ALLOCATION_BELOW_COMMITTED_QUOTA' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        503: {
          description: 'Redis is unavailable or returned an error',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'REDIS_UNAVAILABLE' },
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
        const primaryEvent = await idempotencyService.handleUniqueViolation(idempotencyKey);
        
        // Search for a matching failure event in pg since it doesn't share the same idempotency_key value
        const [failureEvent] = await db.select().from(quotaEvents).where(sql`${quotaEvents.orgId} = ${org.id} AND ${quotaEvents.eventType} = 'ALLOCATION_ADJUST_FAILED' AND ${quotaEvents.metadata}->>'originalIdempotencyKey' = ${idempotencyKey}`).limit(1);

        if (failureEvent) {
          if (failureEvent.metadata && typeof failureEvent.metadata === 'object' && 'error' in failureEvent.metadata) {
            const errMessage = (failureEvent.metadata as any).error;
            if (errMessage && errMessage.includes('RESERVED_EXCEEDS_TOTAL')) {
              return reply.status(422).send({ success: false, error: { code: 'ALLOCATION_BELOW_COMMITTED_QUOTA', message: 'Allocation update would make available quota negative (rejected by Lua)' } });
            }
          }
          return reply.status(503).send({ success: false, error: { code: 'REDIS_UNAVAILABLE', message: 'Redis is unavailable or returned an error' } });
        }
        
        const currentAvailable = await redis.get(`quota:pool:${org.id}:available`);
        return reply.send({ success: true, data: { quotaAllocated: primaryEvent.amount, available: parseInt(currentAvailable || '0', 10) } });
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
        idempotencyKey: undefined,
        metadata: { originalIdempotencyKey: idempotencyKey, error: err.message }
      });
      if (err.message && err.message.includes('RESERVED_EXCEEDS_TOTAL')) {
        return reply.status(422).send({ success: false, error: { code: 'ALLOCATION_BELOW_COMMITTED_QUOTA', message: 'Allocation update would make available quota negative (rejected by Lua)' } });
      }
      return reply.status(503).send({ success: false, error: { code: 'REDIS_UNAVAILABLE', message: 'Redis is unavailable or returned an error' } });
    }

    if (idempotencyKey && eventRecordId) {
      await idempotencyService.mark(idempotencyKey, eventRecordId, fingerprint);
    }

    return reply.send({ success: true, data: { quotaAllocated: amount, available: parseInt(returnedAmount, 10) } });
  });

  fastify.get<{
    Params: { slug: string };
  }>('/:slug/quota/pool', {
    schema: {
      tags: ['Orgs'],
      summary: 'Get organization quota pool details',
      description: 'Admin-only endpoint. Retrieves the real-time quota pool breakdown for an organization from Redis.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: 'Organization slug identifier' },
        },
      },
      response: {
        200: {
          description: 'Current organization quota pool status',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                orgId: { type: 'string', format: 'uuid' },
                slug: { type: 'string', example: 'demo-corp' },
                pool: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer', example: 10000 },
                    reserved: { type: 'integer', example: 500 },
                    loanedOut: { type: 'integer', example: 2000 },
                    received: { type: 'integer', example: 0 },
                    available: { type: 'integer', example: 7500 },
                  },
                  required: ['total', 'reserved', 'loanedOut', 'received', 'available'],
                },
              },
              required: ['orgId', 'slug', 'pool'],
            },
          },
          required: ['success', 'data'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Organization not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Organization not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        500: {
          description: 'Redis read failure or internal error',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INTERNAL_ERROR' },
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
