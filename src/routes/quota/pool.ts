import { FastifyPluginAsync } from 'fastify';
import { redis } from '../../redis';

const poolRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/pool', {
    schema: {
      tags: ['Orgs'],
      summary: 'Get caller organization quota pool',
      description: 'Retrieves the real-time quota pool breakdown for the authenticated caller organization.',
      security: [{ ApiKeyAuth: [] }],
      response: {
        200: {
          description: 'Current quota pool status',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                total: { type: 'integer', example: 10000 },
                reserved: { type: 'integer', example: 500 },
                loanedOut: { type: 'integer', example: 2000 },
                received: { type: 'integer', example: 0 },
                available: { type: 'integer', example: 7500 },
              },
              required: ['total', 'reserved', 'loanedOut', 'received', 'available'],
            },
          },
          required: ['success', 'data'],
        },
        401: {
          description: 'Unauthorized - invalid or missing API key',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'MISSING_API_KEY' },
                message: { type: 'string', example: 'Missing API Key' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        500: {
          description: 'Redis system failure or pipeline error',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INTERNAL_ERROR' },
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
    const { orgId } = request.auth;

    const pipeline = redis.pipeline();
    pipeline.get(`quota:pool:${orgId}:total`);
    pipeline.get(`quota:pool:${orgId}:reserved`);
    pipeline.get(`quota:pool:${orgId}:loaned_out`);
    pipeline.get(`quota:pool:${orgId}:received`);
    pipeline.get(`quota:pool:${orgId}:available`);

    let results;
    try {
      results = await pipeline.exec();
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redis system failure' } });
    }
    
    if (!results) {
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redis pipeline failed' } });
    }

    const [totalErr, totalRes] = results[0];
    const [reservedErr, reservedRes] = results[1];
    const [loanedOutErr, loanedOutRes] = results[2];
    const [receivedErr, receivedRes] = results[3];
    const [availableErr, availableRes] = results[4];

    if (totalErr || reservedErr || loanedOutErr || receivedErr || availableErr) {
      return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redis read error' } });
    }

    return reply.send({ success: true, data: {
        total: parseInt((totalRes as string) || '0', 10),
        reserved: parseInt((reservedRes as string) || '0', 10),
        loanedOut: parseInt((loanedOutRes as string) || '0', 10),
        received: parseInt((receivedRes as string) || '0', 10),
        available: parseInt((availableRes as string) || '0', 10),
      }
    });
  });
};

export default poolRoutes;
