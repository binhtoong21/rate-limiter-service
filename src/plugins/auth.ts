import fp from 'fastify-plugin';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { db } from '../db';
import { apiKeys, services, organizations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { redis } from '../redis';

import { authCheckDuration } from './metrics';

export interface AuthContext {
  serviceId: string;
  orgId: string;
  failOpen: boolean;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export const authPlugin = fp(async (fastify, opts) => {
  fastify.decorateRequest('auth', null as unknown as AuthContext);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health, metrics, and dev routes
    if (
      request.url.startsWith('/health') || 
      request.url.startsWith('/metrics') || 
      request.url.startsWith('/dev/')
    ) {
      return;
    }

    const timer = authCheckDuration.startTimer();

    const apiKey = request.headers['x-api-key'] as string;

    if (!apiKey) {
      timer();
      return reply.status(401).send({ error: 'Missing X-API-Key header' });
    }

    if (!AuthService.isValidFormat(apiKey)) {
      timer();
      return reply.status(401).send({ error: 'Invalid API Key format' });
    }

    const keyHash = AuthService.hashApiKey(apiKey);
    const cacheKey = `apikey:${keyHash}`;

    try {
      // 1. Try L1/L2 basic cache (Redis) with fast failure
      const cached = await redis.get(cacheKey);
      if (cached) {
        request.auth = JSON.parse(cached);
        timer();
        return;
      }
    } catch (error) {
      // Redis is down or timed out. Ignore cache and proceed to DB.
      request.log.warn('Redis cache failed during auth. Falling back to DB.');
    }

    // 2. Fallback to DB
    try {
      const [record] = await db
        .select({
          serviceId: services.id,
          orgId: organizations.id,
          failOpen: organizations.failOpen,
          status: apiKeys.status,
          isAdmin: services.isAdmin,
        })
        .from(apiKeys)
        .innerJoin(services, eq(apiKeys.serviceId, services.id))
        .innerJoin(organizations, eq(services.orgId, organizations.id))
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);

      if (!record || record.status !== 'active') {
        timer();
        return reply.status(401).send({ error: 'Invalid or revoked API Key' });
      }

      const authContext: AuthContext = {
        serviceId: record.serviceId,
        orgId: record.orgId,
        failOpen: record.failOpen,
        isAdmin: record.isAdmin,
      };

      request.auth = authContext;

      // 3. Save back to Redis cache (Increased TTL to 300s to avoid thundering herd)
      // IMPORTANT: Any future /api-keys/:hash revoke route MUST call redis.del(cacheKey)
      try {
        await redis.set(cacheKey, JSON.stringify(authContext), 'EX', 300); // 300 seconds TTL
      } catch (error) {
        request.log.warn('Failed to save auth context to Redis');
      }
      timer();
    } catch (error) {
      request.log.error({ err: error }, 'Database error during auth');
      timer();
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
});
