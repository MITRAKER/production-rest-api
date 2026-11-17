import type { FastifyPluginAsync } from 'fastify';

/**
 * Two health endpoints, the way orchestrators like Kubernetes expect:
 *
 * - GET /health/live  -> "is the process running?"  (never touches the DB)
 * - GET /health/ready -> "can it serve traffic?"     (checks the DB)
 *
 * Keeping them separate means a slow database makes the app "not ready"
 * (so traffic is routed elsewhere) without getting it killed and restarted.
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/live',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/ready',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' }, database: { type: 'string' } },
          },
          503: {
            type: 'object',
            properties: { status: { type: 'string' }, database: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        return { status: 'ok', database: 'up' };
      } catch (err) {
        request.log.error({ err }, 'readiness check failed: database unreachable');
        return reply.code(503).send({ status: 'error', database: 'down' });
      }
    },
  );
};

export default healthRoutes;
