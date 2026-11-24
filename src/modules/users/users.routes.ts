import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { PublicUser } from '../auth/auth.schemas.js';
import { Errors } from '../../lib/errors.js';
import { errorResponses } from '../../lib/responses.js';

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  me: {
    tags: ['users'],
    operationId: 'getCurrentUser',
    summary: 'Get the logged-in user',
    response: { 200: PublicUser.describe('You'), ...errorResponses(401) },
  },
} satisfies Record<string, FastifySchema>;

const usersRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  // Every route in this plugin requires a valid access token. onRequest is
  // the first step of a request: without a token, nothing else runs.
  app.addHook('onRequest', app.authenticate);

  app.get('/me', { schema: schemas.me }, async (request) => {
    const user = await app.prisma.user.findUnique({ where: { id: request.user.sub } });
    // The token can outlive the account (e.g. user deleted), so check.
    if (user === null) throw Errors.unauthorized();
    return user;
  });

  done();
};

export default usersRoutes;
