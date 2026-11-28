import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // What we put inside the token, and what request.user becomes after verifying it.
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Use as an onRequest hook on every route that requires a logged-in user:
     * then a request without a valid token is refused before its body is
     * even read, and its answer never depends on what the body holds.
     */
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Fastify's logger is pino, whose loggers can add fields to all their later
 * lines (setBindings). Fastify's types don't list that method, so check.
 * A request and its reply share one logger: the "request completed" line
 * gets the fields too.
 */
function canSetBindings(
  log: object,
): log is { setBindings: (bindings: Record<string, string>) => void } {
  return 'setBindings' in log && typeof log.setBindings === 'function';
}

export default fp<{ secret: string; accessTtl: string }>(
  async (app, opts) => {
    await app.register(jwt, {
      secret: opts.secret,
      sign: { expiresIn: opts.accessTtl, algorithm: 'HS256' },
      // Pin the algorithm so a token can't trick us into using a weaker one.
      verify: { algorithms: ['HS256'] },
    });

    app.decorate('authenticate', async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
      } catch {
        throw Errors.unauthorized();
      }
      // From now on, every log line of this request says who sent it.
      if (canSetBindings(request.log)) request.log.setBindings({ userId: request.user.sub });
    });
  },
  { name: 'auth' },
);
