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
import { PING_BASE_LIMIT, PING_WINDOW_MS } from '../config/rate-limits';
import { chaosAllowed, startRedisOutage, stopRedisOutage, redisOutageEndsAt } from '../chaos/redis-outage';
import { reconcileOrg } from '../services/reconciliation.service';
import { demoEnabled } from '../config/demo';



export const dashboardPlugin = fp(async (fastify: FastifyInstance) => {
  // The dashboard API is a demo: no API-key auth, seeds admin orgs with well-known keys.
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/dashboard/') || demoEnabled()) return;
    return reply.status(403).send({
      success: false,
      error: {
        code: 'DASHBOARD_DEMO_DISABLED',
        message: 'The demo dashboard API is disabled in production. Set DASHBOARD_DEMO=true only on a private deployment.',
      },
    });
  });
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
    let desyncDetected = false;
    let desyncDetails = '';

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
            pipeline.get(`quota:lease:active_sum:${orgId}`);
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

            // The rate limiter reads quota:lease:active_sum; it must equal the pool's reserved amount
            const activeLeaseSum = parseInt((res?.[5]?.[1] as string) || '0', 10);
            if (activeLeaseSum !== reserved && !desyncDetected) {
              desyncDetected = true;
              desyncDetails = `Leased quota (${reserved}) does not match the lease sum used by the rate limiter (${activeLeaseSum}) for org ${orgId}`;
            }

            return { total, reserved, loanedOut, received, available, activeLeaseSum };
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
              effectiveLimit: PING_BASE_LIMIT + alphaPool.activeLeaseSum,
            },
            {
              id: beta.id,
              name: beta.name,
              slug: beta.slug,
              failOpen: beta.failOpen,
              apiKey: betaKey,
              serviceId: betaService.id,
              pool: betaPool,
              effectiveLimit: PING_BASE_LIMIT + betaPool.activeLeaseSum,
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

    return reply.send({
      success: true,
      data: {
        system: health,
        degraded: !isHealthy,
        organizations: orgsData,
        loans: loansData,
        leases: leasesData,
        events: eventsData,
        limits: {
          baseLimit: PING_BASE_LIMIT,
          windowMs: PING_WINDOW_MS,
        },
        chaos: {
          redisOutageUntil: redisOutageEndsAt(),
        },
        desync: {
          detected: desyncDetected,
          details: desyncDetails,
        },
      },
    });
  });

  // Every mutation needs both stores: PostgreSQL holds the record, Redis the live counters.
  async function requireHealthy(reply: FastifyReply): Promise<boolean> {
    const health = await checkSystemHealth();
    if (health.status === 'healthy') return true;
    reply.status(503).send({
      success: false,
      error: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: `PostgreSQL is ${health.postgres} and Redis is ${health.redis}. Start them with "docker compose up -d".`,
      },
    });
    return false;
  }

  // Map service errors to honest HTTP responses instead of hiding them
  function sendServiceError(reply: FastifyReply, err: any, defaultCode: string) {
    const message: string = err?.message || 'Unexpected error';
    let status = 500;
    let code = defaultCode;
    if (err?.name === 'NotFoundError' || /not found/i.test(message)) {
      status = 404;
      code = 'NOT_FOUND';
    } else if (err?.name === 'InsufficientQuotaError' || message === 'INSUFFICIENT_QUOTA') {
      status = 422;
      code = 'INSUFFICIENT_QUOTA';
    } else if (err?.name === 'ConflictError' || /ALREADY_(SETTLED|RELEASED)|RACE_CONDITION/.test(message)) {
      status = 409;
      code = 'CONFLICT';
    } else if (message === 'SELF_LOAN' || /must be a positive integer/.test(message)) {
      status = 400;
      code = 'INVALID_PARAMETERS';
    }
    if (status === 500) fastify.log.error({ err }, `Dashboard action failed: ${defaultCode}`);
    return reply.status(status).send({ success: false, error: { code, message } });
  }

  const newKey = (prefix: string) => `dash-${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  // --- API ROUTE: POST /api/dashboard/loans ---
  fastify.post<{
    Body: { lenderOrgId: string; borrowerOrgId: string; amount: number; ttlSeconds?: number; note?: string };
  }>('/api/dashboard/loans', async (req, reply) => {
    const { lenderOrgId, borrowerOrgId, amount, ttlSeconds = 3600, note } = req.body || ({} as any);

    if (!lenderOrgId || !borrowerOrgId || lenderOrgId === borrowerOrgId) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'Lender and Borrower must be different organizations' },
      });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive integer' },
      });
    }
    if (!(await requireHealthy(reply))) return reply;

    try {
      const loan = await new LoanService(fastify).createLoan({
        lenderOrgId,
        borrowerOrgId,
        amount,
        ttlSeconds,
        note: note || 'Dashboard Quota Transfer',
        idempotencyKey: newKey('loan'),
      });
      return reply.status(201).send({ success: true, data: loan, message: `Transferred ${amount} quota` });
    } catch (err) {
      return sendServiceError(reply, err, 'LOAN_CREATION_FAILED');
    }
  });

  // --- API ROUTE: POST /api/dashboard/loans/:id/repay ---
  fastify.post<{ Params: { id: string } }>('/api/dashboard/loans/:id/repay', async (req, reply) => {
    if (!(await requireHealthy(reply))) return reply;
    try {
      const settled = await new LoanService(fastify).settleLoan({
        loanId: req.params.id,
        settleType: 'repay',
        idempotencyKey: newKey('repay'),
      });
      return reply.send({ success: true, data: settled, message: 'Loan repaid and quota returned to the lender' });
    } catch (err) {
      return sendServiceError(reply, err, 'SETTLE_FAILED');
    }
  });

  // --- API ROUTE: POST /api/dashboard/loans/:id/cancel ---
  fastify.post<{ Params: { id: string } }>('/api/dashboard/loans/:id/cancel', async (req, reply) => {
    if (!(await requireHealthy(reply))) return reply;
    try {
      const settled = await new LoanService(fastify).settleLoan({
        loanId: req.params.id,
        settleType: 'cancel',
        idempotencyKey: newKey('cancel'),
      });
      return reply.send({ success: true, data: settled, message: 'Loan cancelled and quota reclaimed by the lender' });
    } catch (err) {
      return sendServiceError(reply, err, 'CANCEL_FAILED');
    }
  });

  // --- API ROUTE: POST /api/dashboard/leases ---
  fastify.post<{
    Body: { orgId: string; amount: number; ttlSeconds?: number };
  }>('/api/dashboard/leases', async (req, reply) => {
    const { orgId, amount, ttlSeconds = 60 } = req.body || ({} as any);
    if (!orgId || !Number.isInteger(amount) || amount <= 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'Organization and a positive integer amount are required' },
      });
    }
    if (!(await requireHealthy(reply))) return reply;

    try {
      const [service] = await db.select().from(services).where(eq(services.orgId, orgId)).limit(1);
      if (!service) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No service found for this organization' },
        });
      }
      const lease = await new QuotaService(fastify).claimLease({
        orgId,
        serviceId: service.id,
        amount,
        ttlSeconds,
        idempotencyKey: newKey('lease'),
      });
      return reply.status(201).send({ success: true, data: lease, message: `Claimed lease for ${amount} quota (TTL: ${ttlSeconds}s)` });
    } catch (err) {
      return sendServiceError(reply, err, 'LEASE_CLAIM_FAILED');
    }
  });

  // --- API ROUTE: DELETE /api/dashboard/leases/:id ---
  fastify.delete<{ Params: { id: string } }>('/api/dashboard/leases/:id', async (req, reply) => {
    if (!(await requireHealthy(reply))) return reply;
    try {
      const [existingLease] = await db.select().from(leases).where(eq(leases.id, req.params.id)).limit(1);
      if (!existingLease) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Lease not found' } });
      }
      const released = await new QuotaService(fastify).releaseLease({
        leaseId: req.params.id,
        serviceId: existingLease.serviceId,
      });
      return reply.send({ success: true, data: released, message: 'Lease released' });
    } catch (err) {
      return sendServiceError(reply, err, 'RELEASE_FAILED');
    }
  });

  // --- API ROUTE: POST /api/dashboard/chaos/desync ---
  // Tampers with Redis only (no quota_events row), so Redis and PostgreSQL disagree on purpose.
  fastify.post('/api/dashboard/chaos/desync', async (req, reply) => {
    const driftAmount = 1500;
    if (!(await requireHealthy(reply))) return reply;
    try {
      const [alpha] = await db.select().from(organizations).where(eq(organizations.slug, 'alpha')).limit(1);
      if (!alpha) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Organization alpha not found' } });
      }
      const key = `quota:pool:${alpha.id}:available`;
      const before = parseInt((await redis.get(key)) || '0', 10);
      const after = Math.max(0, before - driftAmount);
      await redis.set(key, after.toString());
      return reply.send({
        success: true,
        message: 'Redis available counter changed without a PostgreSQL event',
        data: { orgId: alpha.id, orgName: alpha.name, before, after, driftAmount: before - after },
      });
    } catch (err) {
      return sendServiceError(reply, err, 'CHAOS_FAILED');
    }
  });

  // --- API ROUTE: POST/DELETE /api/dashboard/chaos/redis-outage ---
  // Development-only drill: the rate limiter behaves as if Redis were unreachable.
  fastify.post<{ Body: { seconds?: number } }>('/api/dashboard/chaos/redis-outage', async (req, reply) => {
    if (!chaosAllowed()) {
      return reply.status(403).send({
        success: false,
        error: { code: 'CHAOS_DISABLED', message: 'Chaos drills are disabled' },
      });
    }
    const seconds = Math.min(120, Math.max(5, Math.floor(Number(req.body?.seconds) || 30)));
    const endsAt = startRedisOutage(seconds);
    return reply.send({ success: true, data: { endsAt, seconds } });
  });

  fastify.delete('/api/dashboard/chaos/redis-outage', async (req, reply) => {
    stopRedisOutage();
    return reply.send({ success: true, data: { endsAt: null } });
  });

  // --- API ROUTE: POST /api/dashboard/chaos/reconcile ---
  // Runs the same per-org reconciliation as the 60s background worker.
  fastify.post('/api/dashboard/chaos/reconcile', async (req, reply) => {
    if (!(await requireHealthy(reply))) return reply;
    try {
      const allOrgs = await db.select().from(organizations);
      let correctedCount = 0;
      for (const org of allOrgs) {
        const result = await reconcileOrg(org);
        if (result.drifted) correctedCount++;
      }
      return reply.send({
        success: true,
        message: correctedCount ? `Corrected ${correctedCount} organization(s)` : 'Redis already matches PostgreSQL',
        correctedCount,
      });
    } catch (err) {
      return sendServiceError(reply, err, 'RECONCILIATION_FAILED');
    }
  });
});
