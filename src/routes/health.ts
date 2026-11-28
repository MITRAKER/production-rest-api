import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../lib/responses.js';

/**
 * Two health endpoints, the way orchestrators like Kubernetes expect:
 *
 * - GET /health/live  -> "is the process running?"  (never touches the DB)
 * - GET /health/ready -> "can it serve traffic?"     (checks the DB)
 *
 * Keeping them separate means a slow database makes the app "not ready"
 * (so traffic is routed elsewhere) without getting it killed and restarted.
 */
const Live = z.object({ status: z.literal('ok') });
const Ready = z.object({ status: z.enum(['ok', 'error']), database: z.enum(['up', 'down']) });

// Public: a load balancer has no token. `security: []` says so in the docs.
const PUBLIC = { tags: ['health'], security: [] };

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  live: {
    ...PUBLIC,
    operationId: 'checkLiveness',
    summary: 'Is the process running?',
    description: 'Never touches the database.',
    response: { 200: Live.describe('The process is running'), ...errorResponses() },
  },
  ready: {
    ...PUBLIC,
    operationId: 'checkReadiness',
    summary: 'Can it serve traffic?',
    description: 'Checks that the database answers. While this says 503, send traffic elsewhere.',
    response: {
      200: Ready.describe('Ready to serve traffic'),
      503: Ready.describe('Not ready: the database is unreachable'),
      ...errorResponses(),
    },
  },
} satisfies Record<string, FastifySchema>;

const healthRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.get('/live', { schema: schemas.live }, () => ({ status: 'ok' as const }));

  app.get('/ready', { schema: schemas.ready }, async (request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' as const, database: 'up' as const };
    } catch (err) {
      request.log.error({ err }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'error', database: 'down' });
    }
  });

  done();
};

export default healthRoutes;
