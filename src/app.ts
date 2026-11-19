import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { LIMITS } from './config/limits.js';
import errorHandler from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import workspacesRoutes from './modules/workspaces/workspaces.routes.js';
import membersRoutes from './modules/workspaces/members.routes.js';
import invitationsRoutes from './modules/invitations/invitations.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';
import tasksRoutes from './modules/tasks/tasks.routes.js';

/** Pretty, colored logs for humans in development; JSON lines everywhere else. */
export function loggerOptions(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>) {
  // Never write credentials or tokens into logs.
  const redact = ['req.headers.authorization', 'req.headers.cookie'];
  if (env.NODE_ENV === 'development') {
    return { level: env.LOG_LEVEL, redact, transport: { target: 'pino-pretty' } };
  }
  return { level: env.LOG_LEVEL, redact };
}

/**
 * Builds the app without starting the HTTP server.
 *
 * Separating "build" from "listen" is what makes the app testable:
 * tests call buildApp() and send fake requests with app.inject(),
 * with no real network port involved.
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env),
    // Give every request an id so its log lines can be traced together.
    genReqId: () => crypto.randomUUID(),
    // Power of Ten rule 3: explicit upper bounds on what a client can make us hold.
    bodyLimit: LIMITS.bodyBytes,
    requestTimeout: LIMITS.requestTimeoutMs,
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
  await app.register(prismaPlugin, {
    databaseUrl: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
  });
  await app.register(authPlugin, { secret: env.JWT_ACCESS_SECRET, accessTtl: env.JWT_ACCESS_TTL });

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, {
    prefix: '/auth',
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
  });
  await app.register(usersRoutes, { prefix: '/users' });
  await app.register(workspacesRoutes, {
    prefix: '/workspaces',
    maxWorkspacesPerUser: env.MAX_WORKSPACES_PER_USER,
  });
  await app.register(membersRoutes, {
    prefix: '/workspaces',
    maxMembersPerWorkspace: env.MAX_MEMBERS_PER_WORKSPACE,
  });
  await app.register(invitationsRoutes, {
    ttlDays: env.INVITATION_TTL_DAYS,
    maxPendingInvitations: env.MAX_PENDING_INVITATIONS,
    maxMembersPerWorkspace: env.MAX_MEMBERS_PER_WORKSPACE,
    maxWorkspacesPerUser: env.MAX_WORKSPACES_PER_USER,
  });
  await app.register(projectsRoutes, {
    prefix: '/workspaces',
    maxProjectsPerWorkspace: env.MAX_PROJECTS_PER_WORKSPACE,
  });
  await app.register(tasksRoutes, {
    prefix: '/workspaces',
    maxTasksPerProject: env.MAX_TASKS_PER_PROJECT,
  });

  return app;
}
