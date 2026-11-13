import { FastifyInstance } from 'fastify';
import { db } from '../../db';
import { organizations, services, apiKeys, quotaEvents } from '../../db/schema';
import { AuthService } from '../../services/auth.service';
import { redis } from '../../redis';

interface BootstrapBody {
  name?: string;
  orgName?: string;
  slug?: string;
  orgSlug?: string;
  serviceName?: string;
  quotaAllocated?: number;
  isAdmin?: boolean;
}

export default async function (fastify: FastifyInstance) {
  // Only register in dev/test mode
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    fastify.log.warn('Skipping dev bootstrap routes outside dev/test environment');
    return;
  }

  fastify.post('/bootstrap', {
    schema: {
      tags: ['Dev'],
      summary: 'Bootstrap organization, service, and API key',
      description: 'Development/testing helper that creates a tenant organization, service, plain-text API key, and initializes Redis quota pool.',
      security: [],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Organization name alias' },
          orgName: { type: 'string', description: 'Organization name' },
          slug: { type: 'string', description: 'Organization slug alias' },
          orgSlug: { type: 'string', description: 'Organization slug identifier' },
          serviceName: { type: 'string', description: 'Service name' },
          quotaAllocated: { type: 'integer', minimum: 0, description: 'Initial allocated quota amount' },
          isAdmin: { type: 'boolean', description: 'Whether the generated service has admin privileges' },
        },
      },
      response: {
        201: {
          description: 'Bootstrap initialized successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                message: { type: 'string', example: 'Bootstrap successful' },
                organization: { type: 'object', additionalProperties: true },
                service: { type: 'object', additionalProperties: true },
                apiKey: { type: 'string', example: 'pk_test_abcdef123456...' },
              },
              required: ['message', 'organization', 'service', 'apiKey'],
            },
          },
          required: ['success', 'data'],
        },
        500: {
          description: 'Bootstrap failure',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INTERNAL_SERVER_ERROR' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    try {
      const body = (request.body as BootstrapBody) || {};
      const orgName = body.orgName || body.name || 'Demo Corp';
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 7);
      const orgSlug = body.orgSlug || body.slug || `demo-${timestamp}-${randomSuffix}`;
      const quotaAllocated = typeof body.quotaAllocated === 'number' ? body.quotaAllocated : 10000;
      const serviceName = body.serviceName || 'Demo Service';
      const isAdmin = body.isAdmin !== undefined ? Boolean(body.isAdmin) : true;

      // 1. Create Organization
      const [org] = await db.insert(organizations).values({
        name: orgName,
        slug: orgSlug,
        quotaAllocated,
        failOpen: true, // Default fail-open for demo to show degradation matrix
      }).returning();

      // 2. Create Service
      const [service] = await db.insert(services).values({
        orgId: org.id,
        name: serviceName,
        isAdmin,
      }).returning();

      // 3. Generate API Key
      const { apiKey, keyHash } = AuthService.generateApiKey('pk_test');
      
      await db.insert(apiKeys).values({
        serviceId: service.id,
        keyHash,
        keyPrefix: apiKey.split('_')[0] + '_' + apiKey.split('_')[1].substring(0, 4), // e.g. pk_test_abcd
        status: 'active'
      });

      // 4. Initialize Redis quota pool
      const pipeline = redis.pipeline();
      pipeline.set(`quota:pool:${org.id}:total`, quotaAllocated.toString());
      pipeline.set(`quota:pool:${org.id}:available`, quotaAllocated.toString());
      pipeline.set(`quota:pool:${org.id}:reserved`, '0');
      pipeline.set(`quota:pool:${org.id}:loaned_out`, '0');
      pipeline.set(`quota:pool:${org.id}:received`, '0');
      await pipeline.exec();

      // 5. Insert initial ALLOCATION_ADJUST event for audit log
      await db.insert(quotaEvents).values({
        eventType: 'ALLOCATION_ADJUST',
        orgId: org.id,
        serviceId: service.id,
        amount: quotaAllocated,
        balanceAfter: quotaAllocated,
      });

      return reply.status(201).send({
        success: true,
        data: {
          message: 'Bootstrap successful',
          organization: org,
          service: service,
          apiKey: apiKey // Only time it is returned in plain text!
        }
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to bootstrap data');
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Bootstrap failed' } });
    }
  });
}
