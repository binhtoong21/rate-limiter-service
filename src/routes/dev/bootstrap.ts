import { FastifyInstance } from 'fastify';
import { db } from '../../db';
import { organizations, services, apiKeys } from '../../db/schema';
import { AuthService } from '../../services/auth.service';

export default async function (fastify: FastifyInstance) {
  // Only register in dev/test mode
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    fastify.log.warn('Skipping dev bootstrap routes outside dev/test environment');
    return;
  }

  fastify.post('/bootstrap', async (request, reply) => {
    try {
      // 1. Create Organization
      const [org] = await db.insert(organizations).values({
        name: 'Demo Corp',
        slug: `demo-${Date.now()}`,
        quotaAllocated: 10000,
        failOpen: true, // Default fail-open for demo to show degradation matrix
      }).returning();

      // 2. Create Service
      const [service] = await db.insert(services).values({
        orgId: org.id,
        name: 'Demo Service',
        isAdmin: false,
      }).returning();

      // 3. Generate API Key
      const { apiKey, keyHash } = AuthService.generateApiKey('pk_test');
      
      await db.insert(apiKeys).values({
        serviceId: service.id,
        keyHash,
        keyPrefix: apiKey.split('_')[0] + '_' + apiKey.split('_')[1].substring(0, 4), // e.g. pk_test_abcd
        status: 'active'
      });

      return reply.status(201).send({
        message: 'Bootstrap successful',
        organization: org,
        service: service,
        apiKey: apiKey // Only time it is returned in plain text!
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to bootstrap data');
      return reply.status(500).send({ error: 'Bootstrap failed' });
    }
  });
}
