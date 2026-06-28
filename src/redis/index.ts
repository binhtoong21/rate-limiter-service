import Redis from 'ioredis';
import pino from 'pino';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimLease(
      poolAvailableKey: string,
      poolReservedKey: string,
      leaseHashKey: string,
      leaseActiveSetKey: string,
      leaseId: string,
      orgId: string,
      serviceId: string,
      amount: string,
      expiresAt: string,
      ttlSeconds: string
    ): Promise<string>;
    
    releaseLease(
      poolAvailableKey: string,
      poolReservedKey: string,
      leaseHashKey: string,
      leaseActiveSetKey: string,
      leaseId: string
    ): Promise<string>;
    
    getEffectiveLimit(
      leaseActiveSetKey: string,
      defaultLimit: string
    ): Promise<number>;
    
    setQuotaPool(
      poolTotalKey: string,
      poolAvailableKey: string,
      poolReservedKey: string,
      newTotalAmount: string
    ): Promise<string>;
  }
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 0, // Fail fast for rate limiting hot path
  connectTimeout: 500,
  commandTimeout: 50,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});
