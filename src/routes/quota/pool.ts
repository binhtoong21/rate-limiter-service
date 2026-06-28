import { FastifyPluginAsync } from 'fastify';
import { redis } from '../../redis';

const poolRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/pool', async (request, reply) => {
    const { orgId } = request.auth;

    const pipeline = redis.pipeline();
    pipeline.get(`quota:pool:${orgId}:total`);
    pipeline.get(`quota:pool:${orgId}:reserved`);
    pipeline.get(`quota:pool:${orgId}:loaned_out`);
    pipeline.get(`quota:pool:${orgId}:received`);
    pipeline.get(`quota:pool:${orgId}:available`);

    const results = await pipeline.exec();
    
    if (!results) {
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Redis pipeline failed' });
    }

    const [totalErr, totalRes] = results[0];
    const [reservedErr, reservedRes] = results[1];
    const [loanedOutErr, loanedOutRes] = results[2];
    const [receivedErr, receivedRes] = results[3];
    const [availableErr, availableRes] = results[4];

    if (totalErr || reservedErr || loanedOutErr || receivedErr || availableErr) {
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Redis read error' });
    }

    return reply.send({
      data: {
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
