import fastify, { FastifyInstance } from 'fastify';
import { authPlugin } from './plugins/auth';
import { metricsPlugin } from './plugins/metrics';
import { luaScriptsPlugin } from './plugins/lua-scripts';
import { rateLimitPlugin } from './plugins/rate-limit';
import systemRoutes from './routes/system';
import devBootstrapRoutes from './routes/dev/bootstrap';
import orgsRoutes from './routes/orgs';
import poolRoutes from './routes/quota/pool';
import leasesRoutes from './routes/quota/leases';
import loansRoutes from './routes/quota/loans';
import eventsRoutes from './routes/quota/events';

export function buildApp(opts = {}): FastifyInstance {
  const app = fastify({
    disableRequestLogging: process.env.NODE_ENV === 'test',
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
      } : undefined
    },
    ...opts
  });

  // Register Plugins
  app.register(metricsPlugin);
  app.register(luaScriptsPlugin);
  app.register(authPlugin);
  app.register(rateLimitPlugin);

  // Register Routes
  app.register(systemRoutes);
  app.register(orgsRoutes, { prefix: '/orgs' });
  app.register(poolRoutes, { prefix: '/quota' });
  app.register(leasesRoutes, { prefix: '/quota' });
  app.register(loansRoutes, { prefix: '/quota/loans' });
  app.register(eventsRoutes, { prefix: '/quota' });
  
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    app.register(devBootstrapRoutes, { prefix: '/dev' });
  }

  // Global Not Found Handler
  app.setNotFoundHandler(function (request, reply) {
    return reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method}:${request.url} not found`
      }
    });
  });

  // Global Error Handler
  app.setErrorHandler(function (error: unknown, request, reply) {
    if (error instanceof Error) {
      const fastifyError = error as any; // Using any for safe property access since FastifyError interface might not match exactly

      // Let fastify handle validation errors with proper status code
      if (fastifyError.validation) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: fastifyError.message,
          }
        });
      }
      
      if (fastifyError.statusCode) {
        let code = 'INTERNAL_SERVER_ERROR';
        if (fastifyError.statusCode === 401) code = 'UNAUTHORIZED';
        if (fastifyError.statusCode === 403) code = 'FORBIDDEN';
        if (fastifyError.statusCode === 404) code = 'NOT_FOUND';
        if (fastifyError.statusCode === 409) code = 'CONFLICT';
        if (fastifyError.statusCode === 429) code = 'TOO_MANY_REQUESTS';
        
        // We might have custom error classes that define their own string codes
        if (fastifyError.code && typeof fastifyError.code === 'string') {
          code = fastifyError.code;
        }
        
        return reply.status(fastifyError.statusCode).send({
          success: false,
          error: {
            code: code,
            message: fastifyError.message
          }
        });
      }

      // Uncaught exception (with Error object)
      this.log.error(error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: fastifyError.message || 'An unexpected error occurred'
        }
      });
    }

    // Uncaught exception (non-Error object)
    this.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred'
      }
    });
  });

  return app;
}
