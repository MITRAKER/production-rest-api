import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import {
  AuthResponse,
  LoginBody,
  RefreshBody,
  RegisterBody,
  TokenResponse,
} from './auth.schemas.js';

/**
 * Routes are thin: validate input (via schema), call the service, shape the
 * response. Business rules live in AuthService so they can be reused and
 * tested without HTTP.
 */
const authRoutes: FastifyPluginAsyncZod<{
  accessTtl: string;
  refreshTtlDays: number;
  rateLimitMax: number;
}> = async (app, opts) => {
  const auth = new AuthService(app, opts);

  // Stricter limit on endpoints attackers would hammer to guess passwords.
  const rateLimit = { rateLimit: { max: opts.rateLimitMax, timeWindow: '1 minute' } };

  app.post(
    '/register',
    {
      config: rateLimit,
      schema: { body: RegisterBody, response: { 201: AuthResponse } },
    },
    async (request, reply) => {
      const result = await auth.register(request.body);
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/login',
    {
      config: rateLimit,
      schema: { body: LoginBody, response: { 200: AuthResponse } },
    },
    async (request) => auth.login(request.body),
  );

  app.post(
    '/refresh',
    {
      config: rateLimit,
      schema: { body: RefreshBody, response: { 200: TokenResponse } },
    },
    async (request) => auth.refresh(request.body.refreshToken),
  );

  app.post(
    '/logout',
    { schema: { body: RefreshBody, response: { 204: z.null() } } },
    async (request, reply) => {
      await auth.logout(request.body.refreshToken);
      return reply.code(204).send(null);
    },
  );
};

export default authRoutes;
