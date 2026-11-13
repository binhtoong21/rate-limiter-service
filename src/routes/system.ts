import { FastifyInstance } from 'fastify';
import { db } from '../db';
import { redis } from '../redis';
import { sql } from 'drizzle-orm';
import { register } from '../plugins/metrics';

export default async function (fastify: FastifyInstance) {
  // Prometheus metrics endpoint (Internal access only)
  // Note: This endpoint is an exception to the standard { data: {}, message?: string }
  // success response format, as Prometheus requires raw text exposition format.
  fastify.get('/metrics', {
    schema: {
      tags: ['System'],
      summary: 'Prometheus metrics endpoint',
      description: 'Returns Prometheus metrics in raw text exposition format for cluster monitoring.',
      security: [],
      response: {
        200: {
          type: 'string',
          description: 'Prometheus text exposition format',
        },
      },
    },
  }, async (request, reply) => {
    reply.header('Content-Type', register.contentType);
    return reply.send(await register.metrics());
  });

  // Healthcheck endpoint
  fastify.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'System health check',
      description: 'Verifies PostgreSQL and Redis connectivity and returns health status.',
      security: [],
      response: {
        200: {
          description: 'All services healthy',
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'], example: 'ok' },
            postgres: { type: 'string', enum: ['up', 'down', 'unknown'], example: 'up' },
            redis: { type: 'string', enum: ['up', 'down', 'unknown'], example: 'up' },
          },
          required: ['status', 'postgres', 'redis'],
        },
        503: {
          description: 'System degraded or dependencies down',
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'], example: 'degraded' },
            postgres: { type: 'string', enum: ['up', 'down', 'unknown'], example: 'down' },
            redis: { type: 'string', enum: ['up', 'down', 'unknown'], example: 'down' },
          },
          required: ['status', 'postgres', 'redis'],
        },
      },
    },
  }, async (request, reply) => {
    const health = {
      status: 'ok',
      postgres: 'unknown',
      redis: 'unknown',
    };

    try {
      await db.execute(sql`SELECT 1`);
      health.postgres = 'up';
    } catch (e) {
      health.postgres = 'down';
      health.status = 'degraded';
    }

    try {
      await redis.ping();
      health.redis = 'up';
    } catch (e) {
      health.redis = 'down';
      health.status = 'degraded';
    }

    const statusCode = health.status === 'ok' ? 200 : 503;
    return reply.status(statusCode).send(health);
  });

  // Demo hot path endpoint
  // Limit: 5 requests per 10 seconds
  fastify.post('/api/ping', {
    schema: {
      tags: ['System'],
      summary: 'Rate-limited ping hot path',
      description: 'Demonstrates distributed rate limiting. Baseline limit: 5 req / 10s, dynamically inflated by active quota leases.',
      security: [{ ApiKeyAuth: [] }],
      response: {
        200: {
          description: 'Request allowed within quota/rate limit',
          type: 'object',
          properties: {
            message: { type: 'string', example: 'pong' },
            orgId: { type: 'string', format: 'uuid' },
            serviceId: { type: 'string', format: 'uuid' },
            timestamp: { type: 'number', example: 1715000000000 },
          },
          required: ['message', 'orgId', 'serviceId', 'timestamp'],
        },
        429: {
          description: 'Rate limit exceeded',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'RATE_LIMIT_EXCEEDED' },
                message: { type: 'string', example: 'Rate limit exceeded' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
    preHandler: async (request, reply) => {
      // 10 seconds window, 5 requests max
      await fastify.checkRateLimit(request, reply, 5, 10000);
    }
  }, async (request, reply) => {
    const auth = request.auth;
    return reply.send({
      message: 'pong',
      orgId: auth.orgId,
      serviceId: auth.serviceId,
      timestamp: Date.now()
    });
  });

  // Benchmark noop route — bypasses auth, rate-limit, and all middleware.
  // Used to measure raw Fastify/Node.js HTTP throughput ceiling.
  // Only available in test/development environments.
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    fastify.get('/bench/noop', {
      schema: {
        tags: ['System'],
        summary: 'Benchmark no-op endpoint',
        description: 'Bypasses auth and rate-limiting for measuring baseline throughput.',
        security: [],
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', example: true },
            },
            required: ['ok'],
          },
        },
      },
      config: { skipAuth: true }
    }, async (request, reply) => {
      return reply.send({ ok: true });
    });
  }
}
