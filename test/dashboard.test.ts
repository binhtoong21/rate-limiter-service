import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

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
});
