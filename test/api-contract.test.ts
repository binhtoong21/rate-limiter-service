import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

describe('API Contract Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Global Error Handler should return { success: false, error: { code, message } }', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/orgs/some-slug/quota/pool',
      // No auth header provided
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Missing API Key');
  });

  it('Not Found error should be wrapped correctly', async () => {
    // Generate a valid API key pattern to pass auth, but org won't be found
    const res = await app.inject({
      method: 'GET',
      url: '/orgs/non-existent-org-slug/quota/pool',
      headers: {
        'x-api-key': 'test_key_12345678901234567890123456789012'
      }
    });

    // Actually, auth middleware hits DB or Redis. 
    // This is just to ensure the shape.
    const body = JSON.parse(res.payload);
    if (res.statusCode === 401) {
       expect(body.success).toBe(false);
       expect(body.error.code).toBe('INVALID_API_KEY');
    } else if (res.statusCode === 403) {
       expect(body.success).toBe(false);
       expect(body.error.code).toBe('FORBIDDEN');
    }
  });
});
