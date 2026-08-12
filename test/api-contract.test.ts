import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

describe('API Contract Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    app.post('/dev/test-validation', {
      schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
      handler: async (req, reply) => reply.send({ success: true })
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 UNAUTHORIZED when Missing API Key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/orgs/some-slug/quota/pool',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing API Key'
      }
    });
  });

  it('should return 401 UNAUTHORIZED for invalid API key format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/orgs/some-slug/quota/pool',
      headers: { 'x-api-key': 'invalidkey' }
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid API Key format'
      }
    });
  });

  it('should return 401 INVALID_API_KEY for non-existent key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/orgs/some-slug/quota/pool',
      headers: { 'x-api-key': 'pk_test_12345678901234567890123456789012' }
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INVALID_API_KEY',
        message: 'Invalid or revoked API Key'
      }
    });
  });

  it('should return 404 NOT_FOUND for unknown routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dev/unknown-route', // Bypasses auth
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET:/dev/unknown-route not found'
      }
    });
  });

  it('should return 400 VALIDATION_ERROR for invalid request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dev/test-validation',
      payload: {} // Missing required 'name' field
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain("body must have required property 'name'");
  });
});
