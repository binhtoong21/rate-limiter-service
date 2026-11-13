import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { quotaEvents } from '../src/db/schema';
import { enforceDeficit } from '../src/services/deficit.service';

// Integration tests: need PostgreSQL + Redis from docker-compose (run: docker compose up -d postgres redis).
describe('Dashboard (real PostgreSQL + Redis)', () => {
  let app: FastifyInstance;
  let alpha: any;
  let beta: any;

  const overview = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).data;
  };
  const org = (data: any, slug: string) => data.organizations.find((o: any) => o.slug === slug);

  beforeAll(async () => {
    process.env.DASHBOARD_DEMO = 'true';
    app = buildApp();
    await app.ready();
    const data = await overview();
    alpha = org(data, 'alpha');
    beta = org(data, 'beta');
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the dashboard page', async () => {
    for (const url of ['/', '/dashboard', '/public/dashboard/index.html']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.payload).toContain('RatePulse');
    }
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.payload).toContain('Rate limit simulator');
    expect(res.payload).toContain('Quota pools');
  });

  it('returns real overview data with limits', async () => {
    const data = await overview();
    expect(data.system.status).toBe('healthy');
    expect(data.degraded).toBe(false);
    expect(data.limits).toEqual({ baseLimit: 5, windowMs: 10000 });
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.pool.total).toBe(10000);
    expect(beta.pool.total).toBe(5000);
    expect(alpha.effectiveLimit).toBe(5 + alpha.pool.activeLeaseSum);
  });

  it('creates and repays a real loan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: 100, ttlSeconds: 60 },
    });
    expect(res.statusCode).toBe(201);
    const loan = JSON.parse(res.payload).data;
    const data = await overview();
    expect(data.loans.some((l: any) => l.id === loan.id && l.status === 'active')).toBe(true);

    const repay = await app.inject({ method: 'POST', url: `/api/dashboard/loans/${loan.id}/repay` });
    expect(repay.statusCode).toBe(200);
  });

  it('rejects a self loan with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: alpha.id, amount: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).success).toBe(false);
  });

  it('rejects a loan larger than the pool with 422 instead of faking success', async () => {
    const data = await overview();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: org(data, 'alpha').pool.available + 1, ttlSeconds: 60 },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).error.code).toBe('INSUFFICIENT_QUOTA');
  });

  it('a lease raises the limit applied by the real rate limiter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/leases',
      payload: { orgId: alpha.id, amount: 7, ttlSeconds: 30 },
    });
    expect(res.statusCode).toBe(201);
    const lease = JSON.parse(res.payload).data;

    const a = org(await overview(), 'alpha');
    const ping = await app.inject({ method: 'POST', url: '/api/ping', headers: { 'x-api-key': a.apiKey } });
    expect([200, 429]).toContain(ping.statusCode);
    expect(Number(ping.headers['x-ratelimit-limit'])).toBe(a.effectiveLimit);

    const rel = await app.inject({ method: 'DELETE', url: `/api/dashboard/leases/${lease.id}` });
    expect(rel.statusCode).toBe(200);
  });

  it('returns 404 for an unknown lease instead of faking success', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/dashboard/leases/00000000-0000-0000-0000-000000000000' });
    expect(res.statusCode).toBe(404);
  });

  it('detects injected Redis drift and heals it with the shared reconciliation', async () => {
    const desync = await app.inject({ method: 'POST', url: '/api/dashboard/chaos/desync' });
    expect(desync.statusCode).toBe(200);
    expect((await overview()).desync.detected).toBe(true);

    const heal = await app.inject({ method: 'POST', url: '/api/dashboard/chaos/reconcile' });
    expect(heal.statusCode).toBe(200);
    expect(JSON.parse(heal.payload).correctedCount).toBeGreaterThanOrEqual(1);
    expect((await overview()).desync.detected).toBe(false);
  });

  it('no longer exposes the fake ping proxy', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dashboard/ping-proxy' });
    expect(res.statusCode).toBe(404);
  });

  it('disables the whole dashboard API in production unless DASHBOARD_DEMO=true', async () => {
    const saved = { env: process.env.NODE_ENV, demo: process.env.DASHBOARD_DEMO };
    process.env.NODE_ENV = 'production';
    delete process.env.DASHBOARD_DEMO;
    try {
      const ov = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
      expect(ov.statusCode).toBe(403);
      expect(JSON.parse(ov.payload).error.code).toBe('DASHBOARD_DEMO_DISABLED');
      expect(ov.payload).not.toContain('pk_test_');
      const loan = await app.inject({
        method: 'POST', url: '/api/dashboard/loans',
        payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: 1 },
      });
      expect(loan.statusCode).toBe(403);
      const drill = await app.inject({ method: 'POST', url: '/api/dashboard/chaos/redis-outage', payload: { seconds: 10 } });
      expect(drill.statusCode).toBe(403);
      const page = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(page.statusCode).toBe(200);
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.demo === undefined) delete process.env.DASHBOARD_DEMO; else process.env.DASHBOARD_DEMO = saved.demo;
    }
  });

  it('Redis outage drill: fail-open org passes, fail-closed org is refused', async () => {
    const data = await overview();
    const a = org(data, 'alpha'); // failOpen: true
    const b = org(data, 'beta'); // failOpen: false
    const start = await app.inject({ method: 'POST', url: '/api/dashboard/chaos/redis-outage', payload: { seconds: 10 } });
    expect(start.statusCode).toBe(200);
    expect((await overview()).chaos.redisOutageUntil).toBeGreaterThan(Date.now());
    try {
      const pa = await app.inject({ method: 'POST', url: '/api/ping', headers: { 'x-api-key': a.apiKey } });
      expect(pa.statusCode).toBe(200);
      expect(pa.headers['x-limiter-fallback']).toBe('fail-open');
      const pb = await app.inject({ method: 'POST', url: '/api/ping', headers: { 'x-api-key': b.apiKey } });
      expect(pb.statusCode).toBe(429);
      expect(pb.headers['x-limiter-fallback']).toBe('fail-closed');
      expect(JSON.parse(pb.payload).error.code).toBe('RATE_LIMITER_DEGRADED');
    } finally {
      const stop = await app.inject({ method: 'DELETE', url: '/api/dashboard/chaos/redis-outage' });
      expect(stop.statusCode).toBe(200);
    }
    const after = await app.inject({ method: 'POST', url: '/api/ping', headers: { 'x-api-key': a.apiKey } });
    expect(after.headers['x-limiter-fallback']).toBeUndefined();
  });

  it('refuses a repay while the borrowed quota is leased out', async () => {
    const before = org(await overview(), 'beta').pool.available;
    const loanRes = await app.inject({
      method: 'POST', url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: 100, ttlSeconds: 60 },
    });
    expect(loanRes.statusCode).toBe(201);
    const loan = JSON.parse(loanRes.payload).data;
    const leaseRes = await app.inject({
      method: 'POST', url: '/api/dashboard/leases',
      payload: { orgId: beta.id, amount: before + 100, ttlSeconds: 60 },
    });
    expect(leaseRes.statusCode).toBe(201);
    const lease = JSON.parse(leaseRes.payload).data;
    try {
      const refused = await app.inject({ method: 'POST', url: `/api/dashboard/loans/${loan.id}/repay` });
      expect(refused.statusCode).toBe(422);
      expect(JSON.parse(refused.payload).error.code).toBe('QUOTA_IN_USE');
      expect(org(await overview(), 'beta').pool.available).toBe(0);
    } finally {
      await app.inject({ method: 'DELETE', url: `/api/dashboard/leases/${lease.id}` });
    }
    const repay = await app.inject({ method: 'POST', url: `/api/dashboard/loans/${loan.id}/repay` });
    expect(repay.statusCode).toBe(200);
    expect(org(await overview(), 'beta').pool.available).toBe(before);
  });

  it('a recall that leaves the borrower short creates a deficit, then the newest lease is revoked', async () => {
    const before = org(await overview(), 'beta').pool.available;
    const loanRes = await app.inject({
      method: 'POST', url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: 100, ttlSeconds: 60 },
    });
    expect(loanRes.statusCode).toBe(201);
    const loan = JSON.parse(loanRes.payload).data;
    const leaseRes = await app.inject({
      method: 'POST', url: '/api/dashboard/leases',
      payload: { orgId: beta.id, amount: before + 100, ttlSeconds: 60 },
    });
    expect(leaseRes.statusCode).toBe(201);
    const lease = JSON.parse(leaseRes.payload).data;

    const recall = await app.inject({ method: 'POST', url: `/api/dashboard/loans/${loan.id}/cancel` });
    expect(recall.statusCode).toBe(200);
    expect(org(await overview(), 'beta').pool.available).toBe(-100);

    const extra = await app.inject({
      method: 'POST', url: '/api/dashboard/leases',
      payload: { orgId: beta.id, amount: 1, ttlSeconds: 60 },
    });
    expect(extra.statusCode).toBe(422);

    const waiting = await enforceDeficit(app, beta.id, { graceMs: 60_000 });
    expect(waiting).toEqual({ deficit: 100, revokedLeaseIds: [] });
    expect(org(await overview(), 'beta').pool.deficitSince).toEqual(expect.any(Number));

    const enforced = await enforceDeficit(app, beta.id, { graceMs: 0 });
    expect(enforced).toEqual({ deficit: 0, revokedLeaseIds: [lease.id] });
    const after = org(await overview(), 'beta').pool;
    expect(after.available).toBe(before);
    expect(after.deficitSince).toBeNull();

    const ev = await db
      .select()
      .from(quotaEvents)
      .where(and(eq(quotaEvents.leaseId, lease.id), eq(quotaEvents.eventType, 'LEASE_RELEASE')));
    expect(ev[0].metadata).toMatchObject({ reason: 'DEFICIT_CLAWBACK' });
  });

  it('shows each loan action once, from the actor, and reports worker liveness', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dashboard/loans',
      payload: { lenderOrgId: alpha.id, borrowerOrgId: beta.id, amount: 10, ttlSeconds: 60 },
    });
    expect(res.statusCode).toBe(201);
    const loan = JSON.parse(res.payload).data;
    const repay = await app.inject({ method: 'POST', url: `/api/dashboard/loans/${loan.id}/repay` });
    expect(repay.statusCode).toBe(200);

    const data = await overview();
    const forLoan = data.events.filter((e: any) => e.loanId === loan.id);
    expect(forLoan.map((e: any) => [e.eventType, e.orgId]).sort()).toEqual(
      [['LOAN_CREATE', alpha.id], ['LOAN_REPAY', beta.id]].sort(),
    );
    expect(typeof data.workers.alive).toBe('boolean');
  });
});
