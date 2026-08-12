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

  return app;
}
