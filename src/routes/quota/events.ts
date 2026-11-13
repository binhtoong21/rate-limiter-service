import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { quotaEvents } from '../../db/schema';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';

const eventSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    eventType: {
      type: 'string',
      enum: [
        'ALLOCATION_ADJUST', 'LEASE_CLAIM', 'LEASE_RELEASE', 'LEASE_EXPIRE',
        'LEASE_CLAIM_FAILED', 'LEASE_RELEASE_FAILED', 'TRANSFER_DEBIT',
        'TRANSFER_CREDIT', 'TRANSFER_FAILED', 'LOAN_CREATE', 'LOAN_REPAY',
        'LOAN_CANCEL', 'LOAN_EXPIRE', 'LOAN_CREATE_FAILED', 'LOAN_REPAY_FAILED',
        'LOAN_CANCEL_FAILED', 'LOAN_EXPIRE_FAILED', 'RECONCILIATION_CORRECTION'
      ],
      example: 'ALLOCATION_ADJUST',
    },
    orgId: { type: 'string', format: 'uuid' },
    counterpartOrgId: { type: ['string', 'null'], format: 'uuid', nullable: true },
    serviceId: { type: ['string', 'null'], format: 'uuid', nullable: true },
    leaseId: { type: ['string', 'null'], format: 'uuid', nullable: true },
    loanId: { type: ['string', 'null'], format: 'uuid', nullable: true },
    amount: { type: 'integer', example: 10000 },
    balanceAfter: { type: 'integer', example: 10000 },
    idempotencyKey: { type: ['string', 'null'], nullable: true },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'eventType', 'orgId', 'amount', 'balanceAfter', 'createdAt'],
  additionalProperties: true,
};

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      event_type?: string;
      service_id?: string;
      limit?: number;
      cursor?: string;
    }
  }>('/events', {
    schema: {
      tags: ['Events'],
      summary: 'Query quota audit events',
      description: 'Admin-only endpoint. Queries append-only quota audit events for the organization with optional event type or service filters and cursor pagination.',
      security: [{ ApiKeyAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          event_type: { type: 'string', description: 'Comma-separated list of event types (e.g. LEASE_CLAIM,LOAN_CREATE)' },
          service_id: { type: 'string', format: 'uuid', description: 'Filter events by service UUID' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Page limit' },
          cursor: { type: 'string', description: 'Base64 cursor for next page' },
        },
      },
      response: {
        200: {
          description: 'Paginated list of quota audit events',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'array',
              items: eventSchema,
            },
            meta: {
              type: 'object',
              properties: {
                next_cursor: { type: ['string', 'null'], nullable: true },
              },
              required: ['next_cursor'],
            },
          },
          required: ['success', 'data', 'meta'],
        },
        400: {
          description: 'Invalid event type requested',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INVALID_EVENT_TYPE' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
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
  }>('/events/:id', {
    schema: {
      tags: ['Events'],
      summary: 'Get quota event by ID',
      description: 'Admin-only endpoint. Retrieves details for a specific quota audit event.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Event UUID' },
        },
      },
      response: {
        200: {
          description: 'Quota audit event details',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: eventSchema,
          },
          required: ['success', 'data'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Event not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Event not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
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
