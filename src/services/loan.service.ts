import { db } from '../db';
import { loans, quotaEvents, organizations } from '../db/schema';
import { redis } from '../redis';
import { idempotencyService } from './idempotency.service';
import { eq, and, sql } from 'drizzle-orm';
import { FastifyInstance } from 'fastify';
import { quotaOperationTotal, quotaOperationDuration } from '../plugins/metrics';

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message = 'Conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

export class LoanService {
  constructor(private fastify: FastifyInstance) {}

  async createLoan(params: {
    lenderOrgId: string;
    borrowerOrgId: string;
    amount: number;
    ttlSeconds: number;
    note?: string;
    idempotencyKey: string;
  }): Promise<typeof loans.$inferSelect> {
    const timer = quotaOperationDuration.startTimer({ type: 'create_loan' });
    try {
      const { lenderOrgId, borrowerOrgId, amount, ttlSeconds, note, idempotencyKey } = params;

    if (lenderOrgId === borrowerOrgId) {
      throw new Error('SELF_LOAN');
    }

    const fingerprint = `${lenderOrgId}:${borrowerOrgId}:${amount}:LOAN_CREATE`;

    // 1. Idempotency Check
    const { exists, cachedResult } = await idempotencyService.check(idempotencyKey, fingerprint);
    if (exists && cachedResult) {
      if (cachedResult.loanId) {
        const [existingLoan] = await db
          .select()
          .from(loans)
          .where(eq(loans.id, cachedResult.loanId))
          .limit(1);
        if (existingLoan) {
          return existingLoan;
        }
      }
      throw new Error('Idempotency collision but loan not found');
    }

    let createdLoanId: string | undefined;
    let createdEventId: string | undefined;
    let returnedLoan: typeof loans.$inferSelect | undefined;

    // 2 & 3. Atomic Unit (PG tx + Lua)
    try {
      await db.transaction(async (tx) => {
        // 2A: Row-level lock on the organizations to serialize concurrent requests
        // Sort orgs to prevent deadlocks when locking multiple rows
        const orgIds = [lenderOrgId, borrowerOrgId].sort();
        for (const id of orgIds) {
          await tx.execute(sql`SELECT id FROM organizations WHERE id = ${id} FOR UPDATE`);
        }

        // 2B: Best-effort balance estimation (now fully synchronized per org)
        const lenderAvailableStr = await redis.get(`quota:pool:${lenderOrgId}:available`);
        const lenderAvailable = parseInt(lenderAvailableStr || '0', 10);
        const lenderBalanceAfter = lenderAvailable - amount;

        if (lenderBalanceAfter < 0) {
          throw new Error('INSUFFICIENT_QUOTA');
        }

        const borrowerAvailableStr = await redis.get(`quota:pool:${borrowerOrgId}:available`);
        const borrowerAvailable = parseInt(borrowerAvailableStr || '0', 10);
        const borrowerBalanceAfter = borrowerAvailable + amount;

        // 3A: Postgres INSERT
        const [newLoan] = await tx
          .insert(loans)
          .values({
            lenderOrgId,
            borrowerOrgId,
            amount,
            status: 'active',
            note,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          })
          .returning();

        createdLoanId = newLoan.id;
        returnedLoan = newLoan;

        // Primary Event (Lender Debit)
        const [lenderEvent] = await tx
          .insert(quotaEvents)
          .values({
            eventType: 'LOAN_CREATE',
            orgId: lenderOrgId,
            counterpartOrgId: borrowerOrgId,
            loanId: newLoan.id,
            amount,
            balanceAfter: lenderBalanceAfter,
            idempotencyKey, // only the primary event gets the idempotency key to satisfy UNIQUE constraint
          })
          .returning();

        createdEventId = lenderEvent.id;

        // Counterpart Event (Borrower Credit)
        await tx
          .insert(quotaEvents)
          .values({
            eventType: 'LOAN_CREATE',
            orgId: borrowerOrgId,
            counterpartOrgId: lenderOrgId,
            loanId: newLoan.id,
            amount,
            balanceAfter: borrowerBalanceAfter,
            // idempotencyKey remains NULL here to avoid UNIQUE constraint violation
          });

        // 3B: Redis Lua
        try {
          const res = await redis.createLoan(
            `quota:pool:${lenderOrgId}:available`,
            `quota:pool:${lenderOrgId}:loaned_out`,
            `quota:pool:${borrowerOrgId}:received`,
            `quota:pool:${borrowerOrgId}:available`,
            `quota:loan:active:lender:${lenderOrgId}`,
            `quota:loan:active:borrower:${borrowerOrgId}`,
            `quota:loan:${newLoan.id}`,
            amount.toString(),
            newLoan.id,
            lenderOrgId,
            borrowerOrgId,
            new Date(newLoan.expiresAt).getTime().toString(),
            ttlSeconds.toString()
          );

          if (!Array.isArray(res) && (res as any).err) {
            throw new Error((res as any).err);
          }
        } catch (luaErr: any) {
          if (luaErr.message && luaErr.message.includes('INSUFFICIENT_QUOTA')) {
            throw new Error('INSUFFICIENT_QUOTA');
          }
          throw luaErr;
        }
      });
    } catch (err: any) {
      if (err.message === 'INSUFFICIENT_QUOTA') {
        // Fallback insert for architecture contract
        await db.insert(quotaEvents).values({
          eventType: 'LOAN_CREATE_FAILED',
          orgId: lenderOrgId,
          counterpartOrgId: borrowerOrgId,
          amount,
          balanceAfter: 0, // Fallback balance
          idempotencyKey, 
          metadata: { reason: err.message }
        }).catch(e => { /* Ignore failure on failure */ });
        throw err;
      }
      
      // PostgreSQL unique violation error constraint_name (porsager driver)
      if (err.code === '23505' && err.constraint_name === 'quota_events_idempotency_key_unique') {
        const existingEvent = await idempotencyService.handleUniqueViolation(idempotencyKey);
        
        if (existingEvent.loanId) {
          const [existingLoan] = await db
            .select()
            .from(loans)
            .where(eq(loans.id, existingEvent.loanId))
            .limit(1);
            
          if (existingLoan) {
            return existingLoan;
          }
        }
        throw new Error('Idempotency collision but loan not found');
      }
      
      throw err;
    }

    // 4. Mark idempotency key in Redis
    if (createdEventId) {
      await idempotencyService.mark(idempotencyKey, createdEventId, fingerprint);
    }

    quotaOperationTotal.inc({ type: 'create_loan', status: 'success' });
    timer();
    return returnedLoan!;
  } catch (err) {
    quotaOperationTotal.inc({ type: 'create_loan', status: 'failure' });
    timer();
    throw err;
  }
}

  async settleLoan(params: {
    loanId: string;
    actorOrgId?: string; // which org initiated this? system if empty
    settleType: 'repay' | 'cancel' | 'expire';
    idempotencyKey?: string;
  }): Promise<typeof loans.$inferSelect> {
    const timer = quotaOperationDuration.startTimer({ type: `settle_loan_${params.settleType}` as any });
    try {
      const { loanId, actorOrgId, settleType, idempotencyKey } = params;
    
    // Determine the status and event type
    let newStatus: 'repaid' | 'cancelled' | 'expired';
    let eventType: 'LOAN_REPAY' | 'LOAN_CANCEL' | 'LOAN_EXPIRE';

    if (settleType === 'repay') {
      newStatus = 'repaid';
      eventType = 'LOAN_REPAY';
    } else if (settleType === 'cancel') {
      newStatus = 'cancelled';
      eventType = 'LOAN_CANCEL';
    } else {
      newStatus = 'expired';
      eventType = 'LOAN_EXPIRE';
    }

    // 1. Optional Idempotency Check
    let fingerprint: string | undefined;
    if (idempotencyKey) {
      fingerprint = `${loanId}:${eventType}`;
      const { exists, cachedResult } = await idempotencyService.check(idempotencyKey, fingerprint);
      if (exists && cachedResult) {
        if (cachedResult.loanId) {
          const [existingLoan] = await db
            .select()
            .from(loans)
            .where(eq(loans.id, cachedResult.loanId))
            .limit(1);
          if (existingLoan) {
            return existingLoan;
          }
        }
        throw new Error('Idempotency collision but loan not found');
      }
    }

    // 2. Fetch current loan state to check Application-Layer Guard
    const [existingLoan] = await db
      .select()
      .from(loans)
      .where(eq(loans.id, loanId))
      .limit(1);

    if (!existingLoan) {
      throw new NotFoundError('Loan not found');
    }

    // If caller provided an actorOrgId, ensure they are authorized for this settleType
    if (actorOrgId) {
      if (settleType === 'repay' && actorOrgId !== existingLoan.borrowerOrgId) {
        throw new Error('UNAUTHORIZED_ACTOR');
      }
      if (settleType === 'cancel' && actorOrgId !== existingLoan.lenderOrgId) {
        throw new Error('UNAUTHORIZED_ACTOR');
      }
    }

    if (existingLoan.status !== 'active') {
      throw new ConflictError('LOAN_ALREADY_SETTLED');
    }

    const { lenderOrgId, borrowerOrgId, amount } = existingLoan;

    let createdEventId: string | undefined;
    let returnedLoan: typeof loans.$inferSelect | undefined;

    // 3 & 4. Atomic Unit
    try {
      await db.transaction(async (tx) => {
        // 3A: Row-level lock on the organizations to serialize concurrent requests
        const orgIds = [lenderOrgId, borrowerOrgId].sort();
        for (const id of orgIds) {
          await tx.execute(sql`SELECT id FROM organizations WHERE id = ${id} FOR UPDATE`);
        }

        // 3B: Best-effort balance estimation (synchronized)
        const lenderAvailableStr = await redis.get(`quota:pool:${lenderOrgId}:available`);
        const lenderAvailable = parseInt(lenderAvailableStr || '0', 10);
        const lenderBalanceAfter = lenderAvailable + amount;

        const borrowerAvailableStr = await redis.get(`quota:pool:${borrowerOrgId}:available`);
        const borrowerAvailable = parseInt(borrowerAvailableStr || '0', 10);
        const borrowerBalanceAfter = borrowerAvailable - amount;

        // 4A: Postgres UPDATE
        const [updatedLoan] = await tx
          .update(loans)
          .set({
            status: newStatus,
            settledAt: new Date().toISOString(),
          })
          .where(and(eq(loans.id, loanId), eq(loans.status, 'active')))
          .returning();

        if (!updatedLoan) {
          throw new ConflictError('RACE_CONDITION_LOAN_ALREADY_SETTLED');
        }
        returnedLoan = updatedLoan;

        // Note: For settlement, which org is the "primary" event org?
        // Let's use the one that initiated it. If system/expire, lender is primary.
        const primaryOrgId = settleType === 'repay' ? borrowerOrgId : lenderOrgId;
        const counterpartOrgId = settleType === 'repay' ? lenderOrgId : borrowerOrgId;
        const primaryBalanceAfter = settleType === 'repay' ? borrowerBalanceAfter : lenderBalanceAfter;
        const counterpartBalanceAfter = settleType === 'repay' ? lenderBalanceAfter : borrowerBalanceAfter;

        // Primary Event
        const [primaryEvent] = await tx
          .insert(quotaEvents)
          .values({
            eventType,
            orgId: primaryOrgId,
            counterpartOrgId,
            loanId,
            amount,
            balanceAfter: primaryBalanceAfter,
            idempotencyKey: idempotencyKey || null,
          })
          .returning();

        createdEventId = primaryEvent.id;

        // Counterpart Event
        await tx
          .insert(quotaEvents)
          .values({
            eventType,
            orgId: counterpartOrgId,
            counterpartOrgId: primaryOrgId,
            loanId,
            amount,
            balanceAfter: counterpartBalanceAfter,
            // no idempotency key for counterpart event
          });

        // 4B: Redis Lua
        try {
          const res = await redis.settleLoan(
            `quota:pool:${lenderOrgId}:available`,
            `quota:pool:${lenderOrgId}:loaned_out`,
            `quota:pool:${borrowerOrgId}:received`,
            `quota:pool:${borrowerOrgId}:available`,
            `quota:loan:active:lender:${lenderOrgId}`,
            `quota:loan:active:borrower:${borrowerOrgId}`,
            `quota:loan:${loanId}`,
            amount.toString(),
            loanId
          );

          if (Array.isArray(res) && res[0] === 'LOAN_ALREADY_SETTLED') {
             // Idempotent success, already settled in Redis
          } else if (!Array.isArray(res) && (res as any).err) {
             throw new Error((res as any).err);
          }
        } catch (luaErr: any) {
          throw luaErr;
        }
      });
    } catch (err: any) {
      if (err.code === '23505' && err.constraint_name === 'quota_events_idempotency_key_unique' && idempotencyKey) {
        const existingEvent = await idempotencyService.handleUniqueViolation(idempotencyKey);
        if (existingEvent.loanId) {
          const [existingLoanCheck] = await db
            .select()
            .from(loans)
            .where(eq(loans.id, existingEvent.loanId))
            .limit(1);
          if (existingLoanCheck) return existingLoanCheck;
        }
        throw new Error('Idempotency collision but loan not found');
      }
      throw err;
    }

    // 5. Mark idempotency key in Redis
    if (idempotencyKey && createdEventId) {
      await idempotencyService.mark(idempotencyKey, createdEventId, fingerprint);
    }

    quotaOperationTotal.inc({ type: `settle_loan_${settleType}` as any, status: 'success' });
    timer();
    return returnedLoan!;
  } catch (err) {
    quotaOperationTotal.inc({ type: `settle_loan_${params.settleType}` as any, status: 'failure' });
    timer();
    throw err;
  }
}
}
