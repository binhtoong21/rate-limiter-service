import fp from 'fastify-plugin';
import { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { redis } from '../redis';

let slidingWindowScriptSha: string;

export const rateLimitPlugin = fp(async (fastify, opts) => {
  // Load script on startup
  const scriptPath = path.join(__dirname, '../redis/scripts/sliding_window_check.lua');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');
  
  try {
    slidingWindowScriptSha = await redis.script('LOAD', scriptContent) as string;
    fastify.log.info({ sha: slidingWindowScriptSha }, 'Loaded sliding_window_check.lua');
  } catch (err) {
    fastify.log.error({ err }, 'Failed to load Lua script');
    throw err;
  }

  fastify.decorate('checkRateLimit', async (request: FastifyRequest, reply: FastifyReply, limit: number, windowSizeMs: number) => {
    const { orgId, failOpen } = request.auth;
    const now = Date.now();
    const currentWindowStart = Math.floor(now / windowSizeMs) * windowSizeMs;
    const previousWindowStart = currentWindowStart - windowSizeMs;
    
    const currentKey = `rl:sw:${orgId}:${currentWindowStart}`;
    const previousKey = `rl:sw:${orgId}:${previousWindowStart}`;
    
    const elapsed = now - currentWindowStart;
    const previousWeight = 1 - (elapsed / windowSizeMs);

    let effectiveLimit = limit;
    try {
      effectiveLimit = await redis.getEffectiveLimit(`quota:lease:active:${orgId}`, limit.toString());
    } catch (err) {
      request.log.error({ err }, 'Failed to get effective limit. Falling back to default limit.');
    }

    try {
      const result = await redis.evalsha(
        slidingWindowScriptSha,
        2, // number of keys
        currentKey,
        previousKey,
        effectiveLimit,
        windowSizeMs,
        now,
        previousWeight
      ) as [number, number];

      const allowed = result[0] === 1;
      const estimatedCount = result[1];

      // Set informative headers
      reply.header('X-RateLimit-Limit', effectiveLimit);
      reply.header('X-RateLimit-Remaining', Math.max(0, effectiveLimit - estimatedCount));
      reply.header('X-RateLimit-Reset', currentWindowStart + windowSizeMs);

      if (!allowed) {
        reply.header('Retry-After', Math.ceil((currentWindowStart + windowSizeMs - now) / 1000));
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
        });
      }
    } catch (err) {
      request.log.error({ err }, 'Rate limit Redis operation failed');
      
      reply.header('X-Limiter-Degraded', 'true');
      if (failOpen) {
        reply.header('X-Limiter-Fallback', 'fail-open');
        // Let it pass through
        return;
      } else if (failOpen === false) {
        reply.header('X-Limiter-Fallback', 'fail-closed');
        reply.header('Retry-After', 30);
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: 'Rate limiter degraded and organization is fail-closed',
        });
      } else {
        reply.header('X-Limiter-Fallback', 'fail-closed');
        reply.header('Retry-After', 30);
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Rate limiter degraded and org config is unknown',
        });
      }
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    checkRateLimit(request: FastifyRequest, reply: FastifyReply, limit: number, windowSizeMs: number): Promise<void>;
  }
}
