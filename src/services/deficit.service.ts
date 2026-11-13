import { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { leases } from '../db/schema';
import { redis } from '../redis';
import { QuotaService } from './quota.service';

/**
 * A deficit happens when a lender recalls a loan (or it expires) while the borrower still has that quota leased:
 * the borrower's available quota drops below zero. As with a lowered Kubernetes ResourceQuota, running leases keep
 * working and new claims are refused. After a grace period the newest leases are revoked until available is back
 * at zero, like a buy-in after a missed securities-lending recall.
 */
export const DEFICIT_GRACE_MS = Number(process.env.DEFICIT_GRACE_SECONDS ?? 300) * 1000;

const deficitKey = (orgId: string) => `quota:pool:${orgId}:deficit_since`;
const availableOf = async (orgId: string) =>
  parseInt((await redis.get(`quota:pool:${orgId}:available`)) || '0', 10);

export async function deficitSince(orgId: string): Promise<number | null> {
  const v = await redis.get(deficitKey(orgId));
  return v ? Number(v) : null;
}

export async function enforceDeficit(
  fastify: FastifyInstance,
  orgId: string,
  opts: { graceMs?: number; now?: number } = {},
): Promise<{ deficit: number; revokedLeaseIds: string[] }> {
  const graceMs = opts.graceMs ?? DEFICIT_GRACE_MS;
  const now = opts.now ?? Date.now();

  let available = await availableOf(orgId);
  if (available >= 0) {
    await redis.del(deficitKey(orgId));
    return { deficit: 0, revokedLeaseIds: [] };
  }

  await redis.set(deficitKey(orgId), String(now), 'NX');
  const since = Number(await redis.get(deficitKey(orgId)));
  if (now - since < graceMs) return { deficit: -available, revokedLeaseIds: [] };

  const active = await db
    .select()
    .from(leases)
    .where(and(eq(leases.orgId, orgId), eq(leases.status, 'active')))
    .orderBy(desc(leases.claimedAt));

  const quota = new QuotaService(fastify);
  const revokedLeaseIds: string[] = [];
  for (const lease of active) {
    if (available >= 0) break;
    try {
      await quota.releaseLease({
        leaseId: lease.id,
        serviceId: lease.serviceId,
        metadata: { reason: 'DEFICIT_CLAWBACK', deficit: -available },
      });
      revokedLeaseIds.push(lease.id);
    } catch (err: any) {
      // Released or expired concurrently: just re-read the balance
      if (err?.message !== 'LEASE_ALREADY_RELEASED' && err?.message !== 'RACE_CONDITION') throw err;
    }
    available = await availableOf(orgId);
  }

  if (available >= 0) await redis.del(deficitKey(orgId));
  return { deficit: Math.max(0, -available), revokedLeaseIds };
}
