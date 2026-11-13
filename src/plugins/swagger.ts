import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export const swaggerPlugin = fp(async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Rate Limiter with Quota Trading API',
        description: 'High-performance distributed rate limiter with multi-tenant dynamic quota leasing and peer-to-peer quota trading.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
            description: 'API key authentication via x-api-key header',
          },
        },
      },
      security: [
        {
          ApiKeyAuth: [],
        },
      ],
      tags: [
        { name: 'System', description: 'System health, metrics, and diagnostics' },
        { name: 'Orgs', description: 'Organization quota allocations and pool views' },
        { name: 'Leases', description: 'Dynamic quota lease lifecycle management' },
        { name: 'Loans', description: 'Peer-to-peer quota loan trading and settlement' },
        { name: 'Events', description: 'Immutable quota audit trail' },
        { name: 'Dev', description: 'Development and testing utilities' },
      ],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformSpecificationClone: true,
  });
});
