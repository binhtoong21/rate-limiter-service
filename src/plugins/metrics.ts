import fp from 'fastify-plugin';
import client from 'prom-client';
import { db } from '../db';
import { organizations } from '../db/schema';
import { metricsRedis } from '../redis';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

// --- Rate Limiting Metrics ---

export const rateLimitRequestsTotal = new client.Counter({
  name: 'rate_limit_requests_total',
  help: 'Count of allowed vs rejected requests',
  labelNames: ['org_id', 'result'] as const,
  registers: [register],
});

export const rateLimitCheckDuration = new client.Histogram({
  name: 'rate_limit_check_duration_seconds',
  help: 'Rate limit check latency in seconds',
  labelNames: ['algorithm'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.010, 0.025, 0.050],
  registers: [register],
});

export const authCheckDuration = new client.Histogram({
  name: 'auth_check_duration_seconds',
  help: 'Auth check latency in seconds',
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.010, 0.025, 0.050],
  registers: [register],
});

// --- Quota Pool Metrics (periodic collection) ---

export const quotaPoolAvailable = new client.Gauge({
  name: 'quota_pool_available',
  help: 'Available balance in the pool',
  labelNames: ['org_id'] as const,
  registers: [register],
});

export const quotaPoolUtilizationRatio = new client.Gauge({
  name: 'quota_pool_utilization_ratio',
  help: 'Reserved quota / total quota ratio',
  labelNames: ['org_id'] as const,
  registers: [register],
});

export const quotaLeaseActiveCount = new client.Gauge({
  name: 'quota_lease_active_count',
  help: 'Count of active leases',
  labelNames: ['org_id'] as const,
  registers: [register],
});

export const quotaLoanActiveCount = new client.Gauge({
  name: 'quota_loan_active_count',
  help: 'Count of active loans',
  labelNames: ['org_id'] as const,
  registers: [register],
});

// --- Operations Metrics ---

export const quotaOperationTotal = new client.Counter({
  name: 'quota_operation_total',
  help: 'Count of quota operations',
  labelNames: ['type', 'status'] as const,
  registers: [register],
});

export const quotaOperationDuration = new client.Histogram({
  name: 'quota_operation_duration_seconds',
  help: 'Quota operation duration in seconds',
  labelNames: ['type'] as const,
  buckets: [0.001, 0.005, 0.010, 0.025, 0.050, 0.100, 0.250, 0.500],
  registers: [register],
});

// --- Reconciliation Metrics ---

export const reconciliationDivergenceTotal = new client.Counter({
  name: 'reconciliation_divergence_detected_total',
  help: 'Total detected state divergences between Redis and PostgreSQL',
  registers: [register],
});

export const reconciliationCorrectionsTotal = new client.Counter({
  name: 'reconciliation_corrections_total',
  help: 'Total automatic state corrections applied to Redis',
  registers: [register],
});

// --- Periodic Gauge Collection ---

let collectionInterval: ReturnType<typeof setTimeout> | null = null;
let collectionInProgress = false;

async function collectPoolGauges() {
  if (collectionInProgress) return;
  collectionInProgress = true;
  try {
    const orgs = await db.select({ id: organizations.id }).from(organizations);

    for (const org of orgs) {
      const pipeline = metricsRedis.pipeline();
      pipeline.get(`quota:pool:${org.id}:total`);
      pipeline.get(`quota:pool:${org.id}:reserved`);
      pipeline.get(`quota:pool:${org.id}:available`);
      pipeline.scard(`quota:lease:active:${org.id}`);
      pipeline.scard(`quota:loan:active:${org.id}`);

      const results = await pipeline.exec();
      if (!results) continue;

      let hasError = false;
      for (const [err] of results) {
        if (err) {
          hasError = true;
          // In a real plugin, we would use fastify.log.error here,
          // but since this is a module-level function, we skip or log to console.
          break;
        }
      }
      
      if (hasError) continue;

      const total = parseInt((results[0][1] as string) || '0', 10);
      const reserved = parseInt((results[1][1] as string) || '0', 10);
      const available = parseInt((results[2][1] as string) || '0', 10);
      const activeLeases = (results[3][1] as number) || 0;
      const activeLoans = (results[4][1] as number) || 0;

      quotaPoolAvailable.set({ org_id: org.id }, available);
      quotaPoolUtilizationRatio.set(
        { org_id: org.id },
        total > 0 ? reserved / total : 0
      );
      quotaLeaseActiveCount.set({ org_id: org.id }, activeLeases);
      quotaLoanActiveCount.set({ org_id: org.id }, activeLoans);
    }
  } catch (err) {
    // Gauge collection is best-effort — don't crash the server
  } finally {
    collectionInProgress = false;
    collectionInterval = setTimeout(collectPoolGauges, 15000);
  }
}

// --- Fastify Plugin ---

export const metricsPlugin = fp(async (fastify) => {
  // Run initial collection and start loop
  collectPoolGauges();

  fastify.addHook('onClose', () => {
    if (collectionInterval) {
      clearTimeout(collectionInterval);
      collectionInterval = null;
    }
  });

  fastify.log.info('Metrics plugin registered');
});

export { register };
