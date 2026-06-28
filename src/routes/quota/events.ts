import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { quotaEvents } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/events', async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ error: 'FORBIDDEN', message: 'Admin access required' });
    }

    const { orgId } = request.auth;

    // TODO(#12): implement cursor pagination. Currently just returning latest 100 for simplicity in Phase 2
    const events = await db
      .select()
      .from(quotaEvents)
      .where(eq(quotaEvents.orgId, orgId))
      .orderBy(desc(quotaEvents.createdAt))
      .limit(100);

    return reply.send({
      data: events
    });
  });
};

export default eventsRoutes;
