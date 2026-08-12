import Redis from 'ioredis';
import pino from 'pino';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimLease(
      poolAvailableKey: string,
      poolReservedKey: string,
      leaseHashKey: string,
      leaseActiveSetKey: string,
      leaseActiveSumKey: string,
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
      leaseActiveSumKey: string,
      leaseId: string,
      amount: string
    ): Promise<string>;
    setQuotaPool(
      poolTotalKey: string,
      poolAvailableKey: string,
      poolReservedKey: string,
      poolLoanedOutKey: string,
      newTotalAmount: string
    ): Promise<string>;
    
    createLoan(
      lenderAvailableKey: string,
      lenderLoanedOutKey: string,
      borrowerReceivedKey: string,
      borrowerAvailableKey: string,
      activeLoansLenderKey: string,
      activeLoansBorrowerKey: string,
      loanHashKey: string,
      amount: string,
      loanId: string,
      lenderOrgId: string,
      borrowerOrgId: string,
      expiresAt: string,
      ttlSeconds: string
    ): Promise<string[] | { err: string }>;
    
    settleLoan(
      lenderAvailableKey: string,
      lenderLoanedOutKey: string,
      borrowerReceivedKey: string,
      borrowerAvailableKey: string,
      activeLoansLenderKey: string,
      activeLoansBorrowerKey: string,
      loanHashKey: string,
      amount: string,
      loanId: string
    ): Promise<string[] | { err: string }>;
  }
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 0, // Fail fast for rate limiting hot path
  connectTimeout: 500,
  commandTimeout: process.env.NODE_ENV === 'test' ? 1000 : 50,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

// Separate Redis client for metrics collection (background, non-hot-path)
// Uses relaxed timeouts per 10-graceful-degradation.md §2.A
export const metricsRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
  connectTimeout: 2000,
  commandTimeout: 500,
});

metricsRedis.on('error', (err) => {
  logger.error({ err }, 'Metrics Redis connection error');
});

