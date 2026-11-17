import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
    /** Use as a preHandler on any route that requires a logged-in user. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
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
    });
  },
  { name: 'auth' },
);
