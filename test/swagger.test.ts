import { describe, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import { swaggerPlugin } from '../src/plugins/swagger';
import systemRoutes from '../src/routes/system';
import devBootstrapRoutes from '../src/routes/dev/bootstrap';
import orgsRoutes from '../src/routes/orgs';
import poolRoutes from '../src/routes/quota/pool';
import leasesRoutes from '../src/routes/quota/leases';
import loansRoutes from '../src/routes/quota/loans';
import eventsRoutes from '../src/routes/quota/events';
import { redis } from '../src/redis';
import { buildApp } from '../src/app';

describe('Swagger / OpenAPI Documentation', () => {
  it('should serve Swagger UI at /docs and OpenAPI spec at /docs/json with full routes', async () => {
    const app = fastify();
    await app.register(swaggerPlugin);

    await app.register(systemRoutes);
    await app.register(orgsRoutes, { prefix: '/orgs' });
    await app.register(poolRoutes, { prefix: '/quota' });
    await app.register(leasesRoutes, { prefix: '/quota' });
    await app.register(loansRoutes, { prefix: '/quota/loans' });
    await app.register(eventsRoutes, { prefix: '/quota' });
    await app.register(devBootstrapRoutes, { prefix: '/dev' });

    await app.ready();

    // 1. Swagger UI HTML
    const docsRes = await app.inject({
      method: 'GET',
      url: '/docs',
    });
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.headers['content-type']).toContain('text/html');

    // 2. OpenAPI JSON Spec
    const jsonRes = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    expect(jsonRes.statusCode).toBe(200);
    const spec = JSON.parse(jsonRes.payload);

    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('Rate Limiter with Quota Trading API');
    expect(spec.components.securitySchemes.ApiKeyAuth).toBeDefined();
    expect(spec.components.securitySchemes.ApiKeyAuth.type).toBe('apiKey');
    expect(spec.components.securitySchemes.ApiKeyAuth.name).toBe('x-api-key');
    expect(spec.components.securitySchemes.ApiKeyAuth.in).toBe('header');

    // Check tags
    const tagNames = spec.tags.map((t: any) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(['System', 'Orgs', 'Leases', 'Loans', 'Events', 'Dev']));

    // Check key route paths
    expect(spec.paths['/health']).toBeDefined();
    expect(spec.paths['/metrics']).toBeDefined();
    expect(spec.paths['/api/ping']).toBeDefined();
    expect(spec.paths['/orgs/{slug}/quota']).toBeDefined();
    expect(spec.paths['/orgs/{slug}/quota/pool']).toBeDefined();
    expect(spec.paths['/quota/pool']).toBeDefined();
    expect(spec.paths['/quota/leases']).toBeDefined();
    expect(spec.paths['/quota/leases/{id}']).toBeDefined();
    expect(spec.paths['/quota/loans/']).toBeDefined();
    expect(spec.paths['/quota/loans/{id}/repay']).toBeDefined();
    expect(spec.paths['/quota/loans/{id}/cancel']).toBeDefined();
    expect(spec.paths['/quota/events']).toBeDefined();
    expect(spec.paths['/quota/events/{id}']).toBeDefined();
    expect(spec.paths['/dev/bootstrap']).toBeDefined();

    await app.close();
  });

  it('should serve /docs without requiring x-api-key through buildApp', async () => {
    // Stub redis.script so luaScriptsPlugin doesn't fail when Redis is offline
    const scriptSpy = vi.spyOn(redis, 'script').mockResolvedValue('dummy-sha' as any);

    const app = buildApp();
    await app.ready();

    // Verify /docs is accessible without x-api-key (public bypass)
    const docsRes = await app.inject({
      method: 'GET',
      url: '/docs',
    });
    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.headers['content-type']).toContain('text/html');

    // Verify /docs/json is accessible without x-api-key
    const jsonRes = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    expect(jsonRes.statusCode).toBe(200);
    const spec = JSON.parse(jsonRes.payload);
    expect(spec.info.title).toBe('Rate Limiter with Quota Trading API');

    await app.close();
    scriptSpy.mockRestore();
  });
});
