import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { quotaEvents } from '../../db/schema';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      event_type?: string;
      service_id?: string;
      limit?: number;
      cursor?: string;
    }
  }>('/events', async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { orgId } = request.auth;
    const { event_type, service_id, limit = 50, cursor } = request.query;

    const queryLimit = Math.min(Math.max(limit, 1), 100);
    const filters = [eq(quotaEvents.orgId, orgId)];

    if (event_type) {
      const allowedTypes = new Set([
        'ALLOCATION_ADJUST', 'LEASE_CLAIM', 'LEASE_RELEASE', 'LEASE_EXPIRE',
        'LEASE_CLAIM_FAILED', 'LEASE_RELEASE_FAILED', 'TRANSFER_DEBIT',
        'TRANSFER_CREDIT', 'TRANSFER_FAILED', 'LOAN_CREATE', 'LOAN_REPAY',
        'LOAN_CANCEL', 'LOAN_EXPIRE', 'LOAN_CREATE_FAILED', 'LOAN_REPAY_FAILED',
        'LOAN_CANCEL_FAILED', 'LOAN_EXPIRE_FAILED', 'RECONCILIATION_CORRECTION'
      ]);
      const types = event_type.split(',');
      for (const t of types) {
        if (!allowedTypes.has(t)) {
          return reply.status(400).send({ success: false, error: { code: 'INVALID_EVENT_TYPE', message: `Invalid event_type: ${t}` } });
        }
      }
      filters.push(inArray(quotaEvents.eventType, types as any[]));
    }
    
    if (service_id) {
      filters.push(eq(quotaEvents.serviceId, service_id));
    }

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        const [cursorTime, cursorId] = decoded.split('_');
        if (cursorTime && cursorId) {
          filters.push(sql`(${quotaEvents.createdAt} < ${cursorTime}::timestamptz OR (${quotaEvents.createdAt} = ${cursorTime}::timestamptz AND ${quotaEvents.id} < ${cursorId}))`);
        }
      } catch (e) {
        // ignore invalid cursor
      }
    }

    const events = await db
      .select()
      .from(quotaEvents)
      .where(and(...filters))
      .orderBy(desc(quotaEvents.createdAt), desc(quotaEvents.id))
      .limit(queryLimit);

    let next_cursor = null;
    if (events.length > 0) {
      const lastItem = events[events.length - 1];
      next_cursor = Buffer.from(`${new Date(lastItem.createdAt).toISOString()}_${lastItem.id}`).toString('base64');
    }

    return reply.send({
      success: true,
      data: events,
      meta: { next_cursor }
    });
  });

  fastify.get<{
    Params: { id: string };
  }>('/events/:id', async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { orgId } = request.auth;
    const { id } = request.params;

    const [event] = await db
      .select()
      .from(quotaEvents)
      .where(and(eq(quotaEvents.id, id), eq(quotaEvents.orgId, orgId)))
      .limit(1);

    if (!event) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Event not found' } });
    }

    return reply.send({
      success: true,
      data: event
    });
  });
};

export default eventsRoutes;
