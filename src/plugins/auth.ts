import fp from 'fastify-plugin';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { db } from '../db';
import { apiKeys, services, organizations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { redis } from '../redis';
import { LRUCache } from 'lru-cache';
import { authSingleFlight } from '../utils/single-flight';

import { authCheckDuration } from './metrics';

const l1Cache = new LRUCache<string, AuthContext>({
  max: 10000,
  ttl: 10000, // 10 seconds TTL for short bounded staleness
});

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
      return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing API Key' } });
    }

    if (!AuthService.isValidFormat(apiKey)) {
      timer();
      return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API Key format' } });
    }

    const keyHash = AuthService.hashApiKey(apiKey);
    const cacheKey = `apikey:${keyHash}`;

    // 1. Try L1 Local Cache (In-Memory)
    const l1Cached = l1Cache.get(cacheKey);
    if (l1Cached) {
      request.auth = l1Cached;
      timer();
      return;
    }

    try {
      // 2. Try L2 Cache (Redis)
      const cached = await redis.get(cacheKey);
      if (cached) {
        const authContext = JSON.parse(cached) as AuthContext;
        l1Cache.set(cacheKey, authContext);
        request.auth = authContext;
        timer();
        return;
      }
    } catch (error) {
      // Redis is down or timed out. Ignore cache and proceed to DB.
      request.log.warn('Redis cache failed during auth. Falling back to DB.');
    }

    // 3. Fallback to DB (Protected by SingleFlight coalescing)
    try {
      const authContext = await authSingleFlight.do(cacheKey, async () => {
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
          throw { statusCode: 401, code: 'INVALID_API_KEY', message: 'Invalid or revoked API Key' };
        }

        const ctx: AuthContext = {
          serviceId: record.serviceId,
          orgId: record.orgId,
          failOpen: record.failOpen,
          isAdmin: record.isAdmin,
        };

        return ctx;
      });

      request.auth = authContext;

      // Save to L1 Cache
      l1Cache.set(cacheKey, authContext);

      // Save back to Redis cache
      try {
        await redis.set(cacheKey, JSON.stringify(authContext), 'EX', 300); // 300 seconds TTL
      } catch (error) {
        request.log.warn('Failed to save auth context to Redis');
      }
      
      timer();
    } catch (error: any) {
      timer();
      if (error.message === 'SINGLEFLIGHT_TOO_MANY_WAITERS') {
        return reply.status(429).send({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many concurrent requests, please try again' } });
      }
      if (error.statusCode) {
        return reply.status(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } });
      }
      request.log.error({ err: error }, 'Database error during auth');
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' } });
    }
  });
});
