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

  // Global Error Handler
  app.setErrorHandler(function (error, request, reply) {
    // Let fastify handle validation errors with proper status code
    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
        }
      });
    }
    
    if (error.statusCode) {
      let code = 'INTERNAL_SERVER_ERROR';
      if (error.statusCode === 401) code = 'UNAUTHORIZED';
      if (error.statusCode === 403) code = 'FORBIDDEN';
      if (error.statusCode === 404) code = 'NOT_FOUND';
      if (error.statusCode === 409) code = 'CONFLICT';
      if (error.statusCode === 429) code = 'TOO_MANY_REQUESTS';
      
      // We might have custom error classes that define their own string codes
      if ((error as any).code && typeof (error as any).code === 'string') {
        code = (error as any).code;
      }
      
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: code,
          message: error.message
        }
      });
    }

    // Uncaught exception
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
