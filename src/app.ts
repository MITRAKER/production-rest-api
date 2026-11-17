import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import prismaPlugin from './plugins/prisma.js';
import healthRoutes from './routes/health.js';

/**
 * Builds the app without starting the HTTP server.
 *
 * Separating "build" from "listen" is what makes the app testable:
 * tests call buildApp() and send fake requests with app.inject(),
 * with no real network port involved.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } }
        : { level: env.LOG_LEVEL },
    // Give every request an id so its log lines can be traced together.
    genReqId: () => crypto.randomUUID(),
  });

  // Echo the request id back so a client can quote it in a bug report,
  // and we can find the exact log lines for that request.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(prismaPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(healthRoutes, { prefix: '/health' });

  return app;
}
