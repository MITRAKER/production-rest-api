import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { PublicUser } from '../auth/auth.schemas.js';
import { Errors } from '../../lib/errors.js';

const usersRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  // Every route in this plugin requires a valid access token.
  app.addHook('preHandler', app.authenticate);

  app.get('/me', { schema: { response: { 200: PublicUser } } }, async (request) => {
    const user = await app.prisma.user.findUnique({ where: { id: request.user.sub } });
    // The token can outlive the account (e.g. user deleted), so check.
    if (user === null) throw Errors.unauthorized();
    return user;
  });

  done();
};

export default usersRoutes;
