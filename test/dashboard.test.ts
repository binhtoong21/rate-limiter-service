import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { dashboardPlugin } from '../src/plugins/dashboard';

describe('Web Dashboard & Live Visual Simulator', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = fastify();
    await app.register(dashboardPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves dashboard HTML at /', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('RatePulse');
    expect(res.payload).toContain('Rate limit simulator');
  });

  it('serves dashboard HTML at /dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Quota pools');
  });

  it('serves static assets under /public/dashboard/index.html', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/public/dashboard/index.html',
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('RatePulse');
  });

  it('returns overview data from /api/dashboard/overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/overview',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.system).toBeDefined();
    expect(body.data.organizations).toHaveLength(2);
    expect(body.data.organizations[0].slug).toBe('alpha');
    expect(body.data.organizations[1].slug).toBe('beta');
    expect(body.data.organizations[0].pool.total).toBe(10000);
    expect(body.data.organizations[1].pool.total).toBe(5000);
    expect(body.data.desync).toBeDefined();
    expect(body.data.limits).toEqual({ baseLimit: 5, windowMs: 10000 });
  });

  it('creates peer-to-peer quota loans via POST /api/dashboard/loans', async () => {
    const overviewRes = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const { organizations } = JSON.parse(overviewRes.payload).data;
    const alpha = organizations.find((o: any) => o.slug === 'alpha');
    const beta = organizations.find((o: any) => o.slug === 'beta');

    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/loans',
      payload: {
        lenderOrgId: alpha.id,
        borrowerOrgId: beta.id,
        amount: 500,
        ttlSeconds: 60,
        note: 'Test Loan Transfer',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.amount).toBe(500);

    // Verify in overview that loan is reflected
    const updatedOverview = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const updatedLoans = JSON.parse(updatedOverview.payload).data.loans;
    expect(updatedLoans.length).toBeGreaterThan(0);
  });

  it('rejects invalid loan parameters (self loan)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/loans',
      payload: {
        lenderOrgId: 'same-org',
        borrowerOrgId: 'same-org',
        amount: 100,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(false);
  });

  it('claims a quota lease via POST /api/dashboard/leases', async () => {
    const overviewRes = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const { organizations } = JSON.parse(overviewRes.payload).data;
    const alpha = organizations.find((o: any) => o.slug === 'alpha');

    const res = await app.inject({
      method: 'POST',
      url: '/api/dashboard/leases',
      payload: {
        orgId: alpha.id,
        amount: 50,
        ttlSeconds: 30,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.amount).toBe(50);
  });

  it('simulates Redis cache desync and heals it via reconciliation', async () => {
    // 1. Trigger desync
    const desyncRes = await app.inject({
      method: 'POST',
      url: '/api/dashboard/chaos/desync',
    });

    expect(desyncRes.statusCode).toBe(200);
    const desyncBody = JSON.parse(desyncRes.payload);
    expect(desyncBody.success).toBe(true);

    // Verify desync is detected in overview
    const overviewAfterDesync = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const desyncData = JSON.parse(overviewAfterDesync.payload).data.desync;
    expect(desyncData.detected).toBe(true);

    // 2. Trigger reconciliation
    const healRes = await app.inject({
      method: 'POST',
      url: '/api/dashboard/chaos/reconcile',
    });

    expect(healRes.statusCode).toBe(200);
    const healBody = JSON.parse(healRes.payload);
    expect(healBody.success).toBe(true);

    // Verify desync is cleared in overview
    const overviewAfterHeal = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const healedData = JSON.parse(overviewAfterHeal.payload).data.desync;
    expect(healedData.detected).toBe(false);
  });

  it('runs rate-limited simulator ping with rate limit enforcement', async () => {
    const overviewRes = await app.inject({ method: 'GET', url: '/api/dashboard/overview' });
    const { organizations } = JSON.parse(overviewRes.payload).data;
    const beta = organizations.find((o: any) => o.slug === 'beta');

    // First request should succeed (200 OK)
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/dashboard/ping-proxy',
      headers: {
        'x-api-key': beta.apiKey,
      },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.payload);
    expect(body1.message).toBe('pong');
    expect(res1.headers['x-ratelimit-limit']).toBeDefined();

    // Rapid requests should eventually hit rate limit (429)
    let throttled = false;
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dashboard/ping-proxy',
        headers: {
          'x-api-key': beta.apiKey,
        },
      });

      if (res.statusCode === 429) {
        throttled = true;
        expect(res.headers['retry-after']).toBeDefined();
        const body = JSON.parse(res.payload);
        expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
        break;
      }
    }

    expect(throttled).toBe(true);
  });
});
