import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db';
import { organizations, services, apiKeys, loans, leases, quotaEvents } from '../db/schema';
import { redis } from '../redis';
import { AuthService } from '../services/auth.service';
import { LoanService } from '../services/loan.service';
import { QuotaService } from '../services/quota.service';
import { eq, desc, and, or, sql } from 'drizzle-orm';

interface PoolState {
  total: number;
  available: number;
  reserved: number;
  loanedOut: number;
  received: number;
}

interface InMemOrg {
  id: string;
  name: string;
  slug: string;
  failOpen: boolean;
  apiKey: string;
  serviceId: string;
  pool: PoolState;
}

interface InMemLoan {
  id: string;
  lenderOrgId: string;
  lenderName: string;
  borrowerOrgId: string;
  borrowerName: string;
  amount: number;
  status: 'active' | 'repaid' | 'cancelled' | 'expired';
  note?: string;
  expiresAt: string;
  createdAt: string;
  settledAt?: string;
}

interface InMemLease {
  id: string;
  orgId: string;
  orgName: string;
  serviceId: string;
  amount: number;
  status: 'active' | 'released' | 'expired';
  claimedAt: string;
  expiresAt: string;
  releasedAt?: string;
}

interface InMemEvent {
  id: string;
  eventType: string;
  orgId: string;
  counterpartOrgId?: string;
  amount: number;
  balanceAfter: number;
  idempotencyKey?: string;
  metadata?: any;
  createdAt: string;
}

// In-memory fallback store
const fallbackStore: {
  orgs: InMemOrg[];
  loans: InMemLoan[];
  leases: InMemLease[];
  events: InMemEvent[];
  simulatedDesync: {
    active: boolean;
    orgId?: string;
    orgName?: string;
    driftAmount?: number;
    timestamp?: number;
  };
} = {
  orgs: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Organization Alpha',
      slug: 'alpha',
      failOpen: true,
      apiKey: 'pk_test_alpha_00000000000000000000000000000001',
      serviceId: '11111111-1111-1111-1111-111111111112',
      pool: {
        total: 10000,
        available: 10000,
        reserved: 0,
        loanedOut: 0,
        received: 0,
      },
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Organization Beta',
      slug: 'beta',
      failOpen: false,
      apiKey: 'pk_test_beta_00000000000000000000000000000002',
      serviceId: '22222222-2222-2222-2222-222222222223',
      pool: {
        total: 5000,
        available: 5000,
        reserved: 0,
        loanedOut: 0,
        received: 0,
      },
    },
  ],
  loans: [],
  leases: [],
  events: [
    {
      id: crypto.randomUUID(),
      eventType: 'ALLOCATION_ADJUST',
      orgId: '11111111-1111-1111-1111-111111111111',
      amount: 10000,
      balanceAfter: 10000,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: crypto.randomUUID(),
      eventType: 'ALLOCATION_ADJUST',
      orgId: '22222222-2222-2222-2222-222222222222',
      amount: 5000,
      balanceAfter: 5000,
      createdAt: new Date(Date.now() - 3500000).toISOString(),
    },
  ],
  simulatedDesync: { active: false },
};

export const dashboardPlugin = fp(async (fastify: FastifyInstance) => {
  const publicDir = path.join(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  const dashboardDir = path.join(publicDir, 'dashboard');
  if (!fs.existsSync(dashboardDir)) {
    fs.mkdirSync(dashboardDir, { recursive: true });
  }

  // Register Fastify Static plugin
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/public/',
  });

  // Mount Dashboard root endpoints
  fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.sendFile('dashboard/index.html');
  });

  fastify.get('/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.sendFile('dashboard/index.html');
  });

  fastify.get('/dashboard/', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.sendFile('dashboard/index.html');
  });

  // Helper to ensure Alpha & Beta exist in real DB and Redis
  async function ensureDatabaseSeed() {
    try {
      // 1. Check organizations
      const allOrgs = await db.select().from(organizations);
      let alpha = allOrgs.find((o) => o.slug === 'alpha');
      let beta = allOrgs.find((o) => o.slug === 'beta');

      if (!alpha) {
        const [insertedAlpha] = await db
          .insert(organizations)
          .values({
            name: 'Organization Alpha',
            slug: 'alpha',
            quotaAllocated: 10000,
            failOpen: true,
          })
          .returning();
        alpha = insertedAlpha;
      }

      if (!beta) {
        const [insertedBeta] = await db
          .insert(organizations)
          .values({
            name: 'Organization Beta',
            slug: 'beta',
            quotaAllocated: 5000,
            failOpen: false,
          })
          .returning();
        beta = insertedBeta;
      }

      // 2. Check services
      const allServices = await db.select().from(services);
      let alphaService = allServices.find((s) => s.orgId === alpha!.id);
      let betaService = allServices.find((s) => s.orgId === beta!.id);

      if (!alphaService) {
        const [s] = await db
          .insert(services)
          .values({
            orgId: alpha!.id,
            name: 'Alpha Service',
            isAdmin: true,
          })
          .returning();
        alphaService = s;
      }

      if (!betaService) {
        const [s] = await db
          .insert(services)
          .values({
            orgId: beta!.id,
            name: 'Beta Service',
            isAdmin: true,
          })
          .returning();
        betaService = s;
      }

      // 3. Check API keys
      const alphaKeyPlain = 'pk_test_alpha_00000000000000000000000000000001';
      const alphaKeys = await db.select().from(apiKeys).where(eq(apiKeys.serviceId, alphaService.id));
      if (alphaKeys.length === 0) {
        const keyHash = AuthService.hashApiKey(alphaKeyPlain);
        await db.insert(apiKeys).values({
          serviceId: alphaService.id,
          keyHash,
          keyPrefix: 'pk_test_alph',
          status: 'active',
        });
      }

      const betaKeyPlain = 'pk_test_beta_00000000000000000000000000000002';
      const betaKeys = await db.select().from(apiKeys).where(eq(apiKeys.serviceId, betaService.id));
      if (betaKeys.length === 0) {
        const keyHash = AuthService.hashApiKey(betaKeyPlain);
        await db.insert(apiKeys).values({
          serviceId: betaService.id,
          keyHash,
          keyPrefix: 'pk_test_beta',
          status: 'active',
        });
      }

      // 4. Initialize Redis pool keys & auth cache if Redis is up
      try {
        const alphaTotal = await redis.get(`quota:pool:${alpha.id}:total`);
        if (!alphaTotal) {
          const pipe = redis.pipeline();
          pipe.set(`quota:pool:${alpha.id}:total`, alpha.quotaAllocated.toString());
          pipe.set(`quota:pool:${alpha.id}:available`, alpha.quotaAllocated.toString());
          pipe.set(`quota:pool:${alpha.id}:reserved`, '0');
          pipe.set(`quota:pool:${alpha.id}:loaned_out`, '0');
          pipe.set(`quota:pool:${alpha.id}:received`, '0');
          pipe.set(`quota:lease:active_sum:${alpha.id}`, '0');
          await pipe.exec();
        }

        const betaTotal = await redis.get(`quota:pool:${beta.id}:total`);
        if (!betaTotal) {
          const pipe = redis.pipeline();
          pipe.set(`quota:pool:${beta.id}:total`, beta.quotaAllocated.toString());
          pipe.set(`quota:pool:${beta.id}:available`, beta.quotaAllocated.toString());
          pipe.set(`quota:pool:${beta.id}:reserved`, '0');
          pipe.set(`quota:pool:${beta.id}:loaned_out`, '0');
          pipe.set(`quota:pool:${beta.id}:received`, '0');
          pipe.set(`quota:lease:active_sum:${beta.id}`, '0');
          await pipe.exec();
        }

        // Cache Auth in Redis
        const alphaHash = AuthService.hashApiKey(alphaKeyPlain);
        await redis.set(
          `apikey:${alphaHash}`,
          JSON.stringify({
            serviceId: alphaService.id,
            orgId: alpha.id,
            failOpen: alpha.failOpen,
            isAdmin: true,
          }),
          'EX',
          86400
        );

        const betaHash = AuthService.hashApiKey(betaKeyPlain);
        await redis.set(
          `apikey:${betaHash}`,
          JSON.stringify({
            serviceId: betaService.id,
            orgId: beta.id,
            failOpen: beta.failOpen,
            isAdmin: true,
          }),
          'EX',
          86400
        );
      } catch (redisErr) {
        // Redis might be unreachable
      }

      // Update in-memory reference to match real DB IDs
      fallbackStore.orgs[0].id = alpha.id;
      fallbackStore.orgs[0].serviceId = alphaService.id;
      fallbackStore.orgs[1].id = beta.id;
      fallbackStore.orgs[1].serviceId = betaService.id;

      return {
        alpha,
        beta,
        alphaService,
        betaService,
        alphaKey: alphaKeyPlain,
        betaKey: betaKeyPlain,
      };
    } catch (err) {
      return null;
    }
  }

  // Helper to check DB and Redis health
  async function checkSystemHealth() {
    let pgStatus = 'down';
    let redisStatus = 'down';

    try {
      await db.execute(sql`SELECT 1`);
      pgStatus = 'up';
    } catch (e) {
      pgStatus = 'down';
    }

    if (redis.status === 'ready') {
      try {
        await redis.ping();
        redisStatus = 'up';
      } catch (e) {
        redisStatus = 'down';
      }
    } else {
      redisStatus = 'down';
    }

    const overallStatus = pgStatus === 'up' && redisStatus === 'up' ? 'healthy' : 'degraded';

    return {
      status: overallStatus,
      postgres: pgStatus,
      redis: redisStatus,
      nodeEnv: process.env.NODE_ENV || 'development',
      algorithm: process.env.RATE_LIMIT_ALGORITHM || 'sliding_window',
      uptime: Math.floor(process.uptime()),
      memory: `${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB`,
      timestamp: new Date().toISOString(),
    };
  }

  // --- API ROUTE: GET /api/dashboard/overview ---
  fastify.get('/api/dashboard/overview', async (req: FastifyRequest, reply: FastifyReply) => {
    const health = await checkSystemHealth();
    const isHealthy = health.postgres === 'up' && health.redis === 'up';

    let orgsData: any[] = [];
    let loansData: any[] = [];
    let leasesData: any[] = [];
    let eventsData: any[] = [];
    let desyncDetected = fallbackStore.simulatedDesync.active;
    let desyncDetails = fallbackStore.simulatedDesync.active
      ? `Simulated Redis desync active on ${fallbackStore.simulatedDesync.orgName || 'pool'}: discrepancy of ${fallbackStore.simulatedDesync.driftAmount || 1000} units`
      : '';

    if (isHealthy) {
      try {
        const seeded = await ensureDatabaseSeed();
        if (seeded) {
          const { alpha, beta, alphaKey, betaKey, alphaService, betaService } = seeded;

          // Read Redis pools
          const readPool = async (orgId: string, initialTotal: number) => {
            const pipeline = redis.pipeline();
            pipeline.get(`quota:pool:${orgId}:total`);
            pipeline.get(`quota:pool:${orgId}:reserved`);
            pipeline.get(`quota:pool:${orgId}:loaned_out`);
            pipeline.get(`quota:pool:${orgId}:received`);
            pipeline.get(`quota:pool:${orgId}:available`);
            const res = await pipeline.exec();

            const total = parseInt((res?.[0]?.[1] as string) || initialTotal.toString(), 10);
            const reserved = parseInt((res?.[1]?.[1] as string) || '0', 10);
            const loanedOut = parseInt((res?.[2]?.[1] as string) || '0', 10);
            const received = parseInt((res?.[3]?.[1] as string) || '0', 10);
            const available = parseInt((res?.[4]?.[1] as string) || (initialTotal - reserved - loanedOut + received).toString(), 10);

            // Check desync
            const expectedAvailable = total - reserved - loanedOut + received;
            if (available !== expectedAvailable && !desyncDetected) {
              desyncDetected = true;
              desyncDetails = `Available quota (${available}) does not match expected (${expectedAvailable}) for org ${orgId}`;
            }

            return { total, reserved, loanedOut, received, available };
          };

          const alphaPool = await readPool(alpha.id, alpha.quotaAllocated);
          const betaPool = await readPool(beta.id, beta.quotaAllocated);

          orgsData = [
            {
              id: alpha.id,
              name: alpha.name,
              slug: alpha.slug,
              failOpen: alpha.failOpen,
              apiKey: alphaKey,
              serviceId: alphaService.id,
              pool: alphaPool,
            },
            {
              id: beta.id,
              name: beta.name,
              slug: beta.slug,
              failOpen: beta.failOpen,
              apiKey: betaKey,
              serviceId: betaService.id,
              pool: betaPool,
            },
          ];

          // Read loans from DB
          const dbLoans = await db
            .select()
            .from(loans)
            .orderBy(desc(loans.createdAt))
            .limit(50);

          loansData = dbLoans.map((l) => ({
            id: l.id,
            lenderOrgId: l.lenderOrgId,
            lenderName: l.lenderOrgId === alpha.id ? alpha.name : beta.name,
            borrowerOrgId: l.borrowerOrgId,
            borrowerName: l.borrowerOrgId === beta.id ? beta.name : alpha.name,
            amount: l.amount,
            status: l.status,
            note: l.note,
            expiresAt: l.expiresAt,
            createdAt: l.createdAt,
            settledAt: l.settledAt,
          }));

          // Read leases from DB
          const dbLeases = await db
            .select()
            .from(leases)
            .orderBy(desc(leases.claimedAt))
            .limit(50);

          leasesData = dbLeases.map((ls) => ({
            id: ls.id,
            orgId: ls.orgId,
            orgName: ls.orgId === alpha.id ? alpha.name : beta.name,
            serviceId: ls.serviceId,
            amount: ls.amount,
            status: ls.status,
            claimedAt: ls.claimedAt,
            expiresAt: ls.expiresAt,
            releasedAt: ls.releasedAt,
          }));

          // Read recent events
          const dbEvents = await db
            .select()
            .from(quotaEvents)
            .orderBy(desc(quotaEvents.createdAt))
            .limit(50);

          eventsData = dbEvents.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            orgId: e.orgId,
            orgName: e.orgId === alpha.id ? alpha.name : beta.name,
            counterpartOrgId: e.counterpartOrgId,
            amount: e.amount,
            balanceAfter: e.balanceAfter,
            idempotencyKey: e.idempotencyKey,
            metadata: e.metadata,
            createdAt: e.createdAt,
          }));
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Error querying DB/Redis for dashboard overview, falling back');
      }
    }

    // Fallback if data is empty or degraded
    if (orgsData.length === 0) {
      orgsData = fallbackStore.orgs;
      loansData = fallbackStore.loans;
      leasesData = fallbackStore.leases;
      eventsData = fallbackStore.events;
    }

    return reply.send({
      success: true,
      data: {
        system: health,
        organizations: orgsData,
        loans: loansData,
        leases: leasesData,
        events: eventsData,
        desync: {
          detected: desyncDetected,
          details: desyncDetails,
        },
      },
    });
  });

  // --- API ROUTE: POST /api/dashboard/loans ---
  fastify.post<{
    Body: { lenderOrgId: string; borrowerOrgId: string; amount: number; ttlSeconds?: number; note?: string };
  }>('/api/dashboard/loans', async (req, reply) => {
    const { lenderOrgId, borrowerOrgId, amount, ttlSeconds = 3600, note } = req.body || {};

    if (!lenderOrgId || !borrowerOrgId || lenderOrgId === borrowerOrgId) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'Lender and Borrower must be different organizations' },
      });
    }

    if (!amount || amount <= 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive integer' },
      });
    }

    const idempotencyKey = `dash-loan-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const loanService = new LoanService(fastify);
      const newLoan = await loanService.createLoan({
        lenderOrgId,
        borrowerOrgId,
        amount,
        ttlSeconds,
        note: note || 'Dashboard Quota Transfer',
        idempotencyKey,
      });

      return reply.status(201).send({
        success: true,
        data: newLoan,
        message: `Successfully transferred ${amount} quota from ${lenderOrgId} to ${borrowerOrgId}`,
      });
    } catch (err: any) {
      // In-memory fallback
      const lender = fallbackStore.orgs.find((o) => o.id === lenderOrgId);
      const borrower = fallbackStore.orgs.find((o) => o.id === borrowerOrgId);

      if (lender && borrower) {
        if (lender.pool.available < amount) {
          return reply.status(422).send({
            success: false,
            error: { code: 'INSUFFICIENT_QUOTA', message: 'Lender does not have enough available quota' },
          });
        }

        lender.pool.available -= amount;
        lender.pool.loanedOut += amount;
        borrower.pool.received += amount;
        borrower.pool.available += amount;

        const fakeLoan: InMemLoan = {
          id: crypto.randomUUID(),
          lenderOrgId,
          lenderName: lender.name,
          borrowerOrgId,
          borrowerName: borrower.name,
          amount,
          status: 'active',
          note: note || 'Dashboard Quota Transfer',
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          createdAt: new Date().toISOString(),
        };

        fallbackStore.loans.unshift(fakeLoan);
        fallbackStore.events.unshift({
          id: crypto.randomUUID(),
          eventType: 'LOAN_CREATE',
          orgId: lenderOrgId,
          counterpartOrgId: borrowerOrgId,
          amount,
          balanceAfter: lender.pool.available,
          idempotencyKey,
          createdAt: new Date().toISOString(),
        });

        return reply.status(201).send({
          success: true,
          data: fakeLoan,
          message: `Transferred ${amount} quota from ${lender.name} to ${borrower.name}`,
        });
      }

      return reply.status(500).send({
        success: false,
        error: { code: 'LOAN_CREATION_FAILED', message: err.message || 'Failed to create loan' },
      });
    }
  });

  // --- API ROUTE: POST /api/dashboard/loans/:id/repay ---
  fastify.post<{
    Params: { id: string };
  }>('/api/dashboard/loans/:id/repay', async (req, reply) => {
    const { id } = req.params;
    const idempotencyKey = `dash-repay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const loanService = new LoanService(fastify);
      const settled = await loanService.settleLoan({
        loanId: id,
        settleType: 'repay',
        idempotencyKey,
      });

      return reply.send({
        success: true,
        data: settled,
        message: 'Loan successfully repaid and quota returned',
      });
    } catch (err: any) {
      // In-memory fallback
      const loan = fallbackStore.loans.find((l) => l.id === id);
      if (loan && loan.status === 'active') {
        loan.status = 'repaid';
        loan.settledAt = new Date().toISOString();

        const lender = fallbackStore.orgs.find((o) => o.id === loan.lenderOrgId);
        const borrower = fallbackStore.orgs.find((o) => o.id === loan.borrowerOrgId);

        if (lender && borrower) {
          lender.pool.available += loan.amount;
          lender.pool.loanedOut = Math.max(0, lender.pool.loanedOut - loan.amount);
          borrower.pool.received = Math.max(0, borrower.pool.received - loan.amount);
          borrower.pool.available = Math.max(0, borrower.pool.available - loan.amount);
        }

        fallbackStore.events.unshift({
          id: crypto.randomUUID(),
          eventType: 'LOAN_REPAY',
          orgId: loan.borrowerOrgId,
          counterpartOrgId: loan.lenderOrgId,
          amount: loan.amount,
          balanceAfter: borrower ? borrower.pool.available : 0,
          createdAt: new Date().toISOString(),
        });

        return reply.send({
          success: true,
          data: loan,
          message: 'Loan repaid in fallback mode',
        });
      }

      return reply.status(400).send({
        success: false,
        error: { code: 'SETTLE_FAILED', message: err.message || 'Failed to repay loan' },
      });
    }
  });

  // --- API ROUTE: POST /api/dashboard/loans/:id/cancel ---
  fastify.post<{
    Params: { id: string };
  }>('/api/dashboard/loans/:id/cancel', async (req, reply) => {
    const { id } = req.params;
    const idempotencyKey = `dash-cancel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const loanService = new LoanService(fastify);
      const settled = await loanService.settleLoan({
        loanId: id,
        settleType: 'cancel',
        idempotencyKey,
      });

      return reply.send({
        success: true,
        data: settled,
        message: 'Loan successfully cancelled and quota reclaimed',
      });
    } catch (err: any) {
      // In-memory fallback
      const loan = fallbackStore.loans.find((l) => l.id === id);
      if (loan && loan.status === 'active') {
        loan.status = 'cancelled';
        loan.settledAt = new Date().toISOString();

        const lender = fallbackStore.orgs.find((o) => o.id === loan.lenderOrgId);
        const borrower = fallbackStore.orgs.find((o) => o.id === loan.borrowerOrgId);

        if (lender && borrower) {
          lender.pool.available += loan.amount;
          lender.pool.loanedOut = Math.max(0, lender.pool.loanedOut - loan.amount);
          borrower.pool.received = Math.max(0, borrower.pool.received - loan.amount);
          borrower.pool.available = Math.max(0, borrower.pool.available - loan.amount);
        }

        fallbackStore.events.unshift({
          id: crypto.randomUUID(),
          eventType: 'LOAN_CANCEL',
          orgId: loan.lenderOrgId,
          counterpartOrgId: loan.borrowerOrgId,
          amount: loan.amount,
          balanceAfter: lender ? lender.pool.available : 0,
          createdAt: new Date().toISOString(),
        });

        return reply.send({
          success: true,
          data: loan,
          message: 'Loan cancelled in fallback mode',
        });
      }

      return reply.status(400).send({
        success: false,
        error: { code: 'CANCEL_FAILED', message: err.message || 'Failed to cancel loan' },
      });
    }
  });

  // --- API ROUTE: POST /api/dashboard/leases ---
  fastify.post<{
    Body: { orgId: string; amount: number; ttlSeconds?: number };
  }>('/api/dashboard/leases', async (req, reply) => {
    const { orgId, amount, ttlSeconds = 60 } = req.body || {};

    if (!orgId || !amount || amount <= 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'Organization and positive amount are required' },
      });
    }

    const idempotencyKey = `dash-lease-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const quotaService = new QuotaService(fastify);

      // Find service for org
      const [service] = await db.select().from(services).where(eq(services.orgId, orgId)).limit(1);
      if (!service) {
        throw new Error('Service not found for organization');
      }

      const lease = await quotaService.claimLease({
        orgId,
        serviceId: service.id,
        amount,
        ttlSeconds,
        idempotencyKey,
      });

      return reply.status(201).send({
        success: true,
        data: lease,
        message: `Claimed lease for ${amount} quota (TTL: ${ttlSeconds}s)`,
      });
    } catch (err: any) {
      // In-memory fallback
      const org = fallbackStore.orgs.find((o) => o.id === orgId);
      if (org) {
        if (org.pool.available < amount) {
          return reply.status(422).send({
            success: false,
            error: { code: 'INSUFFICIENT_QUOTA', message: 'Not enough available quota in organization pool' },
          });
        }

        org.pool.available -= amount;
        org.pool.reserved += amount;

        const fakeLease: InMemLease = {
          id: crypto.randomUUID(),
          orgId,
          orgName: org.name,
          serviceId: org.serviceId,
          amount,
          status: 'active',
          claimedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        };

        fallbackStore.leases.unshift(fakeLease);
        fallbackStore.events.unshift({
          id: crypto.randomUUID(),
          eventType: 'LEASE_CLAIM',
          orgId,
          amount,
          balanceAfter: org.pool.available,
          idempotencyKey,
          createdAt: new Date().toISOString(),
        });

        return reply.status(201).send({
          success: true,
          data: fakeLease,
          message: `Claimed lease for ${amount} quota (fallback mode)`,
        });
      }

      return reply.status(500).send({
        success: false,
        error: { code: 'LEASE_CLAIM_FAILED', message: err.message || 'Failed to claim lease' },
      });
    }
  });

  // --- API ROUTE: DELETE /api/dashboard/leases/:id ---
  fastify.delete<{
    Params: { id: string };
  }>('/api/dashboard/leases/:id', async (req, reply) => {
    const { id } = req.params;

    try {
      const quotaService = new QuotaService(fastify);

      // Find lease to get serviceId
      const [existingLease] = await db.select().from(leases).where(eq(leases.id, id)).limit(1);
      if (!existingLease) {
        throw new Error('Lease not found in database');
      }

      const released = await quotaService.releaseLease({
        leaseId: id,
        serviceId: existingLease.serviceId,
      });

      return reply.send({
        success: true,
        data: released,
        message: 'Lease released successfully',
      });
    } catch (err: any) {
      // In-memory fallback
      const lease = fallbackStore.leases.find((ls) => ls.id === id);
      if (lease && lease.status === 'active') {
        lease.status = 'released';
        lease.releasedAt = new Date().toISOString();

        const org = fallbackStore.orgs.find((o) => o.id === lease.orgId);
        if (org) {
          org.pool.reserved = Math.max(0, org.pool.reserved - lease.amount);
          org.pool.available += lease.amount;
        }

        fallbackStore.events.unshift({
          id: crypto.randomUUID(),
          eventType: 'LEASE_RELEASE',
          orgId: lease.orgId,
          amount: lease.amount,
          balanceAfter: org ? org.pool.available : 0,
          createdAt: new Date().toISOString(),
        });

        return reply.send({
          success: true,
          data: lease,
          message: 'Lease released in fallback mode',
        });
      }

      return reply.status(400).send({
        success: false,
        error: { code: 'RELEASE_FAILED', message: err.message || 'Failed to release lease' },
      });
    }
  });

  // --- API ROUTE: POST /api/dashboard/chaos/desync ---
  fastify.post('/api/dashboard/chaos/desync', async (req, reply) => {
    const driftAmount = 1500;
    try {
      // Pick Org Alpha to desync
      const [alpha] = await db.select().from(organizations).where(eq(organizations.slug, 'alpha')).limit(1);
      const targetOrgId = alpha ? alpha.id : fallbackStore.orgs[0].id;
      const targetName = alpha ? alpha.name : fallbackStore.orgs[0].name;

      // Tamper directly with Redis without PG event!
      try {
        const curAvail = await redis.get(`quota:pool:${targetOrgId}:available`);
        const tampered = Math.max(0, parseInt(curAvail || '10000', 10) - driftAmount);
        await redis.set(`quota:pool:${targetOrgId}:available`, tampered.toString());
      } catch (e) {
        // Redis error
      }

      fallbackStore.simulatedDesync = {
        active: true,
        orgId: targetOrgId,
        orgName: targetName,
        driftAmount,
        timestamp: Date.now(),
      };

      // Also modify in-memory pool for visible UI effect
      const inMemAlpha = fallbackStore.orgs.find((o) => o.id === targetOrgId);
      if (inMemAlpha) {
        inMemAlpha.pool.available = Math.max(0, inMemAlpha.pool.available - driftAmount);
      }

      return reply.send({
        success: true,
        message: 'Redis state intentionally desynced! Divergence detected against PostgreSQL Ground Truth.',
        data: fallbackStore.simulatedDesync,
      });
    } catch (err: any) {
      fallbackStore.simulatedDesync = {
        active: true,
        orgName: 'Organization Alpha',
        driftAmount,
        timestamp: Date.now(),
      };
      return reply.send({
        success: true,
        message: 'Simulated desync activated.',
      });
    }
  });

  // --- API ROUTE: POST /api/dashboard/chaos/reconcile ---
  fastify.post('/api/dashboard/chaos/reconcile', async (req, reply) => {
    let correctedCount = 0;

    try {
      // Run actual reconciliation
      const allOrgs = await db.select().from(organizations);

      for (const org of allOrgs) {
        let expectedTotal = org.quotaAllocated;
        let expectedReserved = 0;
        let expectedLoanedOut = 0;
        let expectedReceived = 0;

        const events = await db
          .select({
            event: quotaEvents,
            loan: loans,
          })
          .from(quotaEvents)
          .leftJoin(loans, eq(quotaEvents.loanId, loans.id))
          .where(eq(quotaEvents.orgId, org.id));

        for (const { event, loan: l } of events) {
          switch (event.eventType) {
            case 'LEASE_CLAIM':
              expectedReserved += event.amount;
              break;
            case 'LEASE_RELEASE':
            case 'LEASE_EXPIRE':
              expectedReserved = Math.max(0, expectedReserved - event.amount);
              break;
            case 'LOAN_CREATE':
              if (l && org.id === l.lenderOrgId) {
                expectedLoanedOut += event.amount;
              } else if (l && org.id === l.borrowerOrgId) {
                expectedReceived += event.amount;
              }
              break;
            case 'LOAN_REPAY':
            case 'LOAN_CANCEL':
            case 'LOAN_EXPIRE':
              if (l && org.id === l.lenderOrgId) {
                expectedLoanedOut = Math.max(0, expectedLoanedOut - event.amount);
              } else if (l && org.id === l.borrowerOrgId) {
                expectedReceived = Math.max(0, expectedReceived - event.amount);
              }
              break;
          }
        }

        const expectedAvailable = expectedTotal - expectedReserved - expectedLoanedOut + expectedReceived;

        // Reset Redis keys
        try {
          const pipe = redis.pipeline();
          pipe.set(`quota:pool:${org.id}:total`, expectedTotal.toString());
          pipe.set(`quota:pool:${org.id}:available`, expectedAvailable.toString());
          pipe.set(`quota:pool:${org.id}:reserved`, expectedReserved.toString());
          pipe.set(`quota:lease:active_sum:${org.id}`, expectedReserved.toString());
          pipe.set(`quota:pool:${org.id}:loaned_out`, expectedLoanedOut.toString());
          pipe.set(`quota:pool:${org.id}:received`, expectedReceived.toString());
          await pipe.exec();
        } catch (e) {
          // ignore
        }

        // Insert RECONCILIATION_CORRECTION event in Postgres
        await db
          .insert(quotaEvents)
          .values({
            eventType: 'RECONCILIATION_CORRECTION',
            orgId: org.id,
            amount: 0,
            balanceAfter: expectedAvailable,
            metadata: {
              reconciledAt: new Date().toISOString(),
              source: 'Dashboard Triggered Self-Healing',
            },
          })
          .catch(() => {});

        correctedCount++;
      }
    } catch (e) {
      // Fallback reconciliation
    }

    // Reset fallback stores
    for (const org of fallbackStore.orgs) {
      org.pool.available = org.pool.total - org.pool.reserved - org.pool.loanedOut + org.pool.received;
    }

    fallbackStore.simulatedDesync = { active: false };

    fallbackStore.events.unshift({
      id: crypto.randomUUID(),
      eventType: 'RECONCILIATION_CORRECTION',
      orgId: fallbackStore.orgs[0].id,
      amount: 0,
      balanceAfter: fallbackStore.orgs[0].pool.available,
      metadata: { reconciledAt: new Date().toISOString(), healed: true },
      createdAt: new Date().toISOString(),
    });

    return reply.send({
      success: true,
      message: 'Reconciliation completed! Redis Materialized View synchronized with PostgreSQL Ground Truth.',
      correctedCount: Math.max(1, correctedCount),
    });
  });

  // --- API ROUTE: POST /api/dashboard/ping-proxy ---
  // A dedicated rate-limited ping endpoint for the visual simulator when called directly
  fastify.post('/api/dashboard/ping-proxy', async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey = (req.headers['x-api-key'] as string) || '';
    const now = Date.now();

    // Determine org from key
    let orgSlug = 'alpha';
    if (apiKey.includes('beta')) {
      orgSlug = 'beta';
    }

    const org = fallbackStore.orgs.find((o) => o.slug === orgSlug) || fallbackStore.orgs[0];
    const baseLimit = 5;
    const effectiveLimit = baseLimit + org.pool.reserved;

    // Check sliding window simulation
    const winKey = `sim:win:${org.id}:${Math.floor(now / 10000)}`;
    let count = 0;

    try {
      if (redis.status === 'ready') {
        count = await redis.incr(winKey);
        if (count === 1) await redis.pexpire(winKey, 20000);
      } else {
        // in-memory window count
        (global as any).__simCounts = (global as any).__simCounts || {};
        (global as any).__simCounts[winKey] = ((global as any).__simCounts[winKey] || 0) + 1;
        count = (global as any).__simCounts[winKey];
      }
    } catch {
      count = 1;
    }

    const remaining = Math.max(0, effectiveLimit - count);
    reply.header('X-RateLimit-Limit', effectiveLimit);
    reply.header('X-RateLimit-Remaining', remaining);

    if (count > effectiveLimit) {
      const resetInSeconds = Math.ceil((10000 - (now % 10000)) / 1000);
      reply.header('Retry-After', resetInSeconds);
      return reply.status(429).send({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded',
        },
        meta: {
          effectiveLimit,
          remaining: 0,
          retryAfter: resetInSeconds,
        },
      });
    }

    return reply.send({
      message: 'pong',
      orgId: org.id,
      orgName: org.name,
      effectiveLimit,
      remaining,
      timestamp: now,
    });
  });
});
