import fp from 'fastify-plugin';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

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
 */
export default fp<{ databaseUrl: string }>(
  async (app, opts) => {
    const adapter = new PrismaPg({ connectionString: opts.databaseUrl });
    const prisma = new PrismaClient({ adapter });

    await prisma.$connect();
    app.decorate('prisma', prisma);

    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  },
  { name: 'prisma' },
);
