import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { db } from '../db';
import { loans, quotaEvents } from '../db/schema';
import { eq, and, lt, sql } from 'drizzle-orm';
import { redis as defaultRedis } from '../redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const startLoanExpiryWorker = async () => {
  // BullMQ requires maxRetriesPerRequest: null
  const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });

  const loanExpiryQueue = new Queue('loan-expiry', { connection: connection as any });

  const loanExpiryWorker = new Worker('loan-expiry', async (job) => {
    // 1. SELECT expired loans (status='active' AND expires_at < NOW()) LIMIT 100
    const expiredLoans = await db
      .select()
      .from(loans)
      .where(and(eq(loans.status, 'active'), lt(loans.expiresAt, sql`${new Date().toISOString()}::timestamptz`)))
      .limit(100);

    if (expiredLoans.length === 0) {
      return { processed: 0 };
    }

    let processed = 0;

    // 2. For each:
    for (const loan of expiredLoans) {
      try {
        const lenderOrgId = loan.lenderOrgId;
        const borrowerOrgId = loan.borrowerOrgId;
        const amount = loan.amount;

        // b. DB transaction (with row-level lock)
        await db.transaction(async (tx) => {
          // Lock orgs in deterministic order
          const orgIds = [lenderOrgId, borrowerOrgId].sort();
          for (const id of orgIds) {
            await tx.execute(sql`SELECT id FROM organizations WHERE id = ${id} FOR UPDATE`);
          }

          // a. Best effort balance estimation (synchronized)
          const lenderAvailableStr = await defaultRedis.get(`quota:pool:${lenderOrgId}:available`);
          const lenderAvailable = parseInt(lenderAvailableStr || '0', 10);
          const lenderBalanceAfter = lenderAvailable + amount;

          const borrowerAvailableStr = await defaultRedis.get(`quota:pool:${borrowerOrgId}:available`);
          const borrowerAvailable = parseInt(borrowerAvailableStr || '0', 10);
          const borrowerBalanceAfter = borrowerAvailable - amount;

          const [updatedLoan] = await tx
            .update(loans)
            .set({ 
              status: 'expired',
              settledAt: new Date().toISOString()
            })
            .where(and(eq(loans.id, loan.id), eq(loans.status, 'active')))
            .returning();

          if (!updatedLoan) {
            return; // Already settled concurrently
          }

          // Primary event (Lender is treated as primary for expiry since system initiated)
          await tx.insert(quotaEvents).values({
            eventType: 'LOAN_EXPIRE',
            orgId: lenderOrgId,
            counterpartOrgId: borrowerOrgId,
            loanId: loan.id,
            amount: loan.amount,
            balanceAfter: lenderBalanceAfter,
          });

          // Counterpart event
          await tx.insert(quotaEvents).values({
            eventType: 'LOAN_EXPIRE',
            orgId: borrowerOrgId,
            counterpartOrgId: lenderOrgId,
            loanId: loan.id,
            amount: loan.amount,
            balanceAfter: borrowerBalanceAfter,
          });

          // EVALSHA settle_loan.lua
          // ⚠️ Redis Lua không tham gia PG transaction, crash recovery applies.
          const res = await defaultRedis.settleLoan(
            `quota:pool:${lenderOrgId}:available`,
            `quota:pool:${lenderOrgId}:loaned_out`,
            `quota:pool:${borrowerOrgId}:received`,
            `quota:pool:${borrowerOrgId}:available`,
            `quota:loan:active:lender:${lenderOrgId}`,
            `quota:loan:active:borrower:${borrowerOrgId}`,
            `quota:loan:${loan.id}`,
            loan.amount.toString(),
            loan.id
          );
          
          if (!Array.isArray(res) && (res as any).err) {
            if ((res as any).err !== 'LOAN_ALREADY_SETTLED') {
               throw new Error((res as any).err);
            }
          }
        });
        processed++;
      } catch (err) {
        logger.error({ err, loanId: loan.id }, 'Failed to process expired loan');
      }
    }

    if (processed > 0) {
      logger.info(`Processed ${processed} expired loans in batch`);
    }

    return { processed };
  }, { connection: connection as any });

  loanExpiryWorker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Loan expiry job failed');
  });

  // Setup repeatable job every 30 seconds
  await loanExpiryQueue.add('scan-expired-loans', {}, {
    repeat: {
      every: 30000,
    }
  });
};
