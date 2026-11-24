import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
import { AuthService } from './auth.service.js';
import {
  AuthResponse,
  LoginBody,
  RefreshBody,
  RegisterBody,
  TokenResponse,
} from './auth.schemas.js';

// No access token needed for these: `security: []` says so in the docs.
const PUBLIC = { tags: ['auth'], security: [] };

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  register: {
    ...PUBLIC,
    operationId: 'register',
    summary: 'Create an account',
    description:
      'Creates the account and logs it in. Limited to a few attempts a minute from one IP address.',
    body: RegisterBody,
    response: {
      201: AuthResponse.describe('The new account, logged in'),
      ...errorResponses(400, 409, 429),
    },
  },
  login: {
    ...PUBLIC,
    operationId: 'login',
    summary: 'Log in',
    description:
      'An unknown email and a wrong password get the same answer (INVALID_CREDENTIALS), so ' +
      'nobody can find out which emails have an account. Rate limited, like sign-up.',
    body: LoginBody,
    response: { 200: AuthResponse.describe('Logged in'), ...errorResponses(400, 401, 429) },
  },
  refresh: {
    ...PUBLIC,
    operationId: 'refreshTokens',
    summary: 'Trade a refresh token for new tokens',
    description:
      'A refresh token works once: the answer has the next one. Sending one a second time ' +
      'ends its whole session (INVALID_REFRESH_TOKEN), since only a stolen copy would be ' +
      'used twice. Rate limited.',
    body: RefreshBody,
    response: {
      200: TokenResponse.describe('New tokens; the one sent no longer works'),
      ...errorResponses(400, 401, 429),
    },
  },
  logout: {
    ...PUBLIC,
    operationId: 'logout',
    summary: 'Log out',
    description: 'Ends the session of this refresh token. Answers 204 even for an unknown token.',
    body: RefreshBody,
    response: { 204: z.null().describe('Logged out'), ...errorResponses(400) },
  },
} satisfies Record<string, FastifySchema>;

/**
 * Routes are thin: validate input (via schema), call the service, shape the
 * response. Business rules live in AuthService so they can be reused and
 * tested without HTTP.
 *
 * Registering routes does no async work, so this plugin uses Fastify's
 * callback form and calls done() when it's finished.
 */
const authRoutes: FastifyPluginCallbackZod<{
  accessTtl: string;
  refreshTtlDays: number;
  rateLimitMax: number;
}> = (app, opts, done) => {
  const auth = new AuthService(app, opts);

  // Stricter limit on endpoints attackers would hammer to guess passwords.
  const rateLimit = { rateLimit: { max: opts.rateLimitMax, timeWindow: '1 minute' } };

  app.post('/register', { config: rateLimit, schema: schemas.register }, async (request, reply) => {
    const result = await auth.register(request.body);
    return reply.code(201).send(result);
  });

  app.post('/login', { config: rateLimit, schema: schemas.login }, async (request) =>
    auth.login(request.body),
  );

  app.post('/refresh', { config: rateLimit, schema: schemas.refresh }, async (request) =>
    auth.refresh(request.body.refreshToken, request.log),
  );

  app.post('/logout', { schema: schemas.logout }, async (request, reply) => {
    await auth.logout(request.body.refreshToken);
    return reply.code(204).send(null);
  });

  done();
};

export default authRoutes;
