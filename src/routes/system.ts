import { FastifyInstance } from 'fastify';
import { db } from '../db';
import { redis } from '../redis';
import { sql } from 'drizzle-orm';
import { register } from '../plugins/metrics';

export default async function (fastify: FastifyInstance) {
  // Prometheus metrics endpoint
  fastify.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', register.contentType);
    return reply.send(await register.metrics());
  });

  // Healthcheck endpoint
  fastify.get('/health', async (request, reply) => {
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
}
