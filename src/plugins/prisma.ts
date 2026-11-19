import fp from 'fastify-plugin';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { LIMITS } from '../config/limits.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

/**
 * Creates one PrismaClient (which holds a pool of Postgres connections),
 * attaches it to the app as `app.prisma`, and closes it when the app shuts down.
 *
 * `fastify-plugin` (fp) makes the decoration visible to the whole app
 * instead of only inside this plugin's own scope.
 *
 * The pool is bounded (Power of Ten rule 3): at most `poolMax` connections,
 * a bounded wait for a free one, a per-statement timeout in Postgres, and a
 * time limit for every transaction (Prisma's defaults, 2 s to start and 5 s
 * in total, would otherwise apply silently).
 */
export default fp<{ databaseUrl: string; poolMax: number }>(
  async (app, opts) => {
    const adapter = new PrismaPg({
      connectionString: opts.databaseUrl,
      max: opts.poolMax,
      connectionTimeoutMillis: LIMITS.dbConnectTimeoutMs,
      idleTimeoutMillis: LIMITS.dbIdleTimeoutMs,
      statement_timeout: LIMITS.dbStatementTimeoutMs,
    });
    const prisma = new PrismaClient({
      adapter,
      transactionOptions: {
        maxWait: LIMITS.dbConnectTimeoutMs,
        timeout: LIMITS.dbTransactionTimeoutMs,
      },
    });

    await prisma.$connect();
    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
