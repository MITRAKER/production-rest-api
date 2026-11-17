import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import errorHandler from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';

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
        : {
            level: env.LOG_LEVEL,
            // Never write credentials or tokens into logs.
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    // Give every request an id so its log lines can be traced together.
    genReqId: () => crypto.randomUUID(),
  });

  // Let Zod schemas validate requests and serialize responses.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Echo the request id back so a client can quote it in a bug report,
  // and we can find the exact log lines for that request.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(errorHandler);
  // global: false -> only routes that opt in (via config.rateLimit) are limited.
  await app.register(rateLimit, { global: false });
  await app.register(prismaPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(authPlugin, { secret: env.JWT_ACCESS_SECRET, accessTtl: env.JWT_ACCESS_TTL });

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, {
    prefix: '/auth',
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
  });
  await app.register(usersRoutes, { prefix: '/users' });

  return app;
}
