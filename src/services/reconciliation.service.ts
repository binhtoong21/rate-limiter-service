import pino from 'pino';
import { db } from '../db';
import { organizations, quotaEvents, loans } from '../db/schema';
import { eq, asc, sql } from 'drizzle-orm';
import { redis as defaultRedis } from '../redis';
import { reconciliationDivergenceTotal, reconciliationCorrectionsTotal } from '../plugins/metrics';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface ReconcileResult {
  orgId: string;
  drifted: boolean;
  driftAmount: number;
}

/**
 * Rebuild one org's Redis quota counters and active sets from its PostgreSQL event log.
 * Used by the 60s reconciliation worker and by the dashboard's manual "reconcile" action.
 */
export async function reconcileOrg(org: typeof organizations.$inferSelect): Promise<ReconcileResult> {
  const orgId = org.id;
  let drifted = false;
  let driftAmount = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`);

    let expectedTotal = 0;
    let expectedReserved = 0;
    let expectedLoanedOut = 0;
    let expectedReceived = 0;

    const activeLeaseIds = new Set<string>();
    const activeLenderLoanIds = new Set<string>();
    const activeBorrowerLoanIds = new Set<string>();

    // Replay all events for the org
    const events = await tx
      .select({
        event: quotaEvents,
        loan: loans
      })
      .from(quotaEvents)
      .leftJoin(loans, eq(quotaEvents.loanId, loans.id))
      .where(eq(quotaEvents.orgId, orgId))
      .orderBy(asc(quotaEvents.createdAt), asc(quotaEvents.id));

    for (const { event, loan } of events) {
      switch (event.eventType) {
        case 'ALLOCATION_ADJUST':
          // In this design, ALLOCATION_ADJUST might just set the total or increase it.
          // We'll just assume expectedTotal is org.quotaAllocated for simplicity, 
          // unless we are doing incremental changes.
          // Actually, according to schema, quotaAllocated is the single source of truth for total.
          break;
        case 'LEASE_CLAIM':
          expectedReserved += event.amount;
          if (event.leaseId) activeLeaseIds.add(event.leaseId);
          break;
        case 'LEASE_RELEASE':
        case 'LEASE_EXPIRE':
          expectedReserved -= event.amount;
          if (event.leaseId) activeLeaseIds.delete(event.leaseId);
          break;
        case 'LOAN_CREATE':
          if (loan && orgId === loan.lenderOrgId) {
            expectedLoanedOut += event.amount;
            if (event.loanId) activeLenderLoanIds.add(event.loanId);
          } else if (loan && orgId === loan.borrowerOrgId) {
            expectedReceived += event.amount;
            if (event.loanId) activeBorrowerLoanIds.add(event.loanId);
          }
          break;
        case 'LOAN_REPAY':
        case 'LOAN_CANCEL':
        case 'LOAN_EXPIRE':
          if (loan && orgId === loan.lenderOrgId) {
            expectedLoanedOut -= event.amount;
            if (event.loanId) activeLenderLoanIds.delete(event.loanId);
          } else if (loan && orgId === loan.borrowerOrgId) {
            expectedReceived -= event.amount;
            if (event.loanId) activeBorrowerLoanIds.delete(event.loanId);
          }
          break;
        // Other events don't affect these specific counters
      }
    }
    
    // QuotaAllocated is the source of truth for total
    expectedTotal = org.quotaAllocated;
    const expectedAvailable = expectedTotal - expectedReserved - expectedLoanedOut + expectedReceived;

    const currentTotal = parseInt(await defaultRedis.get(`quota:pool:${orgId}:total`) || '0', 10);
    const currentAvailable = parseInt(await defaultRedis.get(`quota:pool:${orgId}:available`) || '0', 10);
    const currentReserved = parseInt(await defaultRedis.get(`quota:pool:${orgId}:reserved`) || '0', 10);
    const currentLoanedOut = parseInt(await defaultRedis.get(`quota:pool:${orgId}:loaned_out`) || '0', 10);
    const currentReceived = parseInt(await defaultRedis.get(`quota:pool:${orgId}:received`) || '0', 10);
    const currentActiveSum = parseInt(await defaultRedis.get(`quota:lease:active_sum:${orgId}`) || '0', 10);

    if (expectedTotal !== currentTotal) {
      drifted = true;
      driftAmount += Math.abs(expectedTotal - currentTotal);
    }
    if (expectedAvailable !== currentAvailable) {
      drifted = true;
      driftAmount += Math.abs(expectedAvailable - currentAvailable);
    }
    if (expectedReserved !== currentReserved) {
      drifted = true;
      driftAmount += Math.abs(expectedReserved - currentReserved);
    }
    if (expectedReserved !== currentActiveSum) {
      drifted = true;
      // Don't add to driftAmount twice since it represents the same underlying discrepancy
    }
    if (expectedLoanedOut !== currentLoanedOut) {
      drifted = true;
      driftAmount += Math.abs(expectedLoanedOut - currentLoanedOut);
    }
    if (expectedReceived !== currentReceived) {
      drifted = true;
      driftAmount += Math.abs(expectedReceived - currentReceived);
    }

    // Active Sets are corrected every time if there's any counter drift, 
    // or we could check them explicitly. We'll check actual members instead of just count.
    const redisActiveLeases = await defaultRedis.smembers(`quota:lease:active:${orgId}`);
    const redisActiveLenderLoans = await defaultRedis.smembers(`quota:loan:active:lender:${orgId}`);
    const redisActiveBorrowerLoans = await defaultRedis.smembers(`quota:loan:active:borrower:${orgId}`);
    
    const areSetsEqual = (a: string[], b: Set<string>) => {
      if (a.length !== b.size) return false;
      for (const item of a) {
        if (!b.has(item)) return false;
      }
      return true;
    };

    if (!areSetsEqual(redisActiveLeases, activeLeaseIds)) drifted = true;
    if (!areSetsEqual(redisActiveLenderLoans, activeLenderLoanIds)) drifted = true;
    if (!areSetsEqual(redisActiveBorrowerLoans, activeBorrowerLoanIds)) drifted = true;

    if (drifted) {
      reconciliationDivergenceTotal.inc();
      
      logger.warn({
        orgId,
        expected: { total: expectedTotal, available: expectedAvailable, reserved: expectedReserved, loaned_out: expectedLoanedOut, received: expectedReceived },
        actual: { total: currentTotal, available: currentAvailable, reserved: currentReserved, loaned_out: currentLoanedOut, received: currentReceived }
      }, 'Drift detected, correcting Redis state...');

      const pipeline = defaultRedis.pipeline();
      pipeline.set(`quota:pool:${orgId}:total`, expectedTotal.toString());
      pipeline.set(`quota:pool:${orgId}:available`, expectedAvailable.toString());
      pipeline.set(`quota:pool:${orgId}:reserved`, expectedReserved.toString());
      pipeline.set(`quota:lease:active_sum:${orgId}`, expectedReserved.toString());
      pipeline.set(`quota:pool:${orgId}:loaned_out`, expectedLoanedOut.toString());
      pipeline.set(`quota:pool:${orgId}:received`, expectedReceived.toString());
      
      pipeline.del(`quota:lease:active:${orgId}`);
      if (activeLeaseIds.size > 0) pipeline.sadd(`quota:lease:active:${orgId}`, ...Array.from(activeLeaseIds));
      
      pipeline.del(`quota:loan:active:lender:${orgId}`);
      if (activeLenderLoanIds.size > 0) pipeline.sadd(`quota:loan:active:lender:${orgId}`, ...Array.from(activeLenderLoanIds));
      
      pipeline.del(`quota:loan:active:borrower:${orgId}`);
      if (activeBorrowerLoanIds.size > 0) pipeline.sadd(`quota:loan:active:borrower:${orgId}`, ...Array.from(activeBorrowerLoanIds));

      await pipeline.exec();
      reconciliationCorrectionsTotal.inc();
      
      if (driftAmount > 0) {
        await tx.insert(quotaEvents).values({
          eventType: 'RECONCILIATION_CORRECTION',
          orgId: orgId,
          amount: driftAmount,
          balanceAfter: expectedAvailable,
          metadata: {
            previous_state: {
              total: currentTotal, available: currentAvailable, reserved: currentReserved, loaned_out: currentLoanedOut, received: currentReceived
            },
            corrected_state: {
              total: expectedTotal, available: expectedAvailable, reserved: expectedReserved, loaned_out: expectedLoanedOut, received: expectedReceived
            }
          }
        });
      }
    }
  });

  return { orgId, drifted, driftAmount };
}
