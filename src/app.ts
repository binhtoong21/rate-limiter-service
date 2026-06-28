import fastify, { FastifyInstance } from 'fastify';
import { authPlugin } from './plugins/auth';
import { luaScriptsPlugin } from './plugins/lua-scripts';
import { rateLimitPlugin } from './plugins/rate-limit';
import systemRoutes from './routes/system';
import devBootstrapRoutes from './routes/dev/bootstrap';

export function buildApp(opts = {}): FastifyInstance {
  const app = fastify({
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
  app.register(luaScriptsPlugin);
  app.register(authPlugin);
  app.register(rateLimitPlugin);

  // Register Routes
  app.register(systemRoutes);
  
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    app.register(devBootstrapRoutes, { prefix: '/dev' });
  }

  return app;
}
