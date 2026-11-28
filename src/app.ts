import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { LIMITS } from './config/limits.js';
import errorHandler, { answerFrameworkError } from './plugins/error-handler.js';
import openapi from './plugins/openapi.js';
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

/** What a request id from upstream may look like: a UUID and most tracing ids fit. */
const UPSTREAM_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * Every request gets an id, so its log lines can be found together. When a
 * proxy or another service in front of us already gave the request one (the
 * x-request-id header), we keep it: then one id follows the request through
 * every service. It's still input like any other, so it's used only if it
 * looks like an id; anything else gets a fresh one.
 */
export function requestIdFor(request: Pick<IncomingMessage, 'headers'>): string {
  const upstream = request.headers['x-request-id'];
  return typeof upstream === 'string' && UPSTREAM_REQUEST_ID.test(upstream)
    ? upstream
    : crypto.randomUUID();
}

export interface BuildOptions {
  /** Where log lines go instead of stdout: the tests read them. */
  logStream?: { write: (line: string) => void };
}

/**
 * Builds the app without starting the HTTP server.
 *
 * Separating "build" from "listen" is what makes the app testable:
 * tests call buildApp() and send fake requests with app.inject(),
 * with no real network port involved.
 */
export async function buildApp(env: Env, options: BuildOptions = {}): Promise<FastifyInstance> {
  const logger = loggerOptions(env);
  const app = Fastify({
    logger: options.logStream === undefined ? logger : { ...logger, stream: options.logStream },
    genReqId: requestIdFor,
    // Power of Ten rule 3: explicit upper bounds on what a client can make us hold.
    bodyLimit: LIMITS.bodyBytes,
    requestTimeout: LIMITS.requestTimeoutMs,
    routerOptions: {
      // "/workspaces/" is the same address as "/workspaces" (and the docs show only that one).
      ignoreTrailingSlash: true,
      maxParamLength: LIMITS.pathParamChars,
    },
    // The errors Fastify raises before it finds a route get our error shape too.
    frameworkErrors: answerFrameworkError,
  });

  // Let Zod schemas validate requests and serialize responses.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The API reads JSON only. Fastify would also read text/plain (what fetch()
  // sends for a string body without a content type) and hand the route a
  // string: such a body now gets 415 UNSUPPORTED_MEDIA_TYPE, which says what's wrong.
  app.removeContentTypeParser('text/plain');

  // Echo the request id back so a client can quote it in a bug report,
  // and we can find the exact log lines for that request.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(errorHandler);
  // Before the routes: it documents each route as it's added.
  await app.register(openapi);
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
