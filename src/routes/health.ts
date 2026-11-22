import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

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

const healthRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.get('/live', { schema: { response: { 200: Live } } }, () => ({ status: 'ok' as const }));

  app.get(
    '/ready',
    { schema: { response: { 200: Ready, 503: Ready } } },
    async (request, reply) => {
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        return { status: 'ok' as const, database: 'up' as const };
      } catch (err) {
        request.log.error({ err }, 'readiness check failed: database unreachable');
        return reply.code(503).send({ status: 'error', database: 'down' });
      }
    },
  );

  done();
};

export default healthRoutes;
