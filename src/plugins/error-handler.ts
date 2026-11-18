import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

/**
 * One place that turns every error into the same JSON shape:
 *
 *   { "error": { "code": "EMAIL_TAKEN", "message": "...", "details": [...] } }
 *
 * Unexpected errors are logged in full but the client only sees a generic
 * message, so we never leak stack traces or SQL to the outside world.
 */
export default fp(
  async (app) => {
    app.setErrorHandler((err, request, reply) => {
      if (hasZodFastifySchemaValidationErrors(err)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: err.validation.map((v) => ({
              path: v.instancePath || '/',
              message: v.message,
            })),
          },
        });
      }

      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          error: { code: err.code, message: err.message, details: err.details },
        });
      }

      // Errors Fastify itself raises (e.g. 429 from rate limiting, 415 bad content type).
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
        return reply.code(e.statusCode).send({
          error: { code: e.statusCode === 429 ? 'RATE_LIMITED' : (e.code ?? 'BAD_REQUEST'), message: e.message ?? 'Bad request' },
        });
      }

      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      });
    });

    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      });
    });
  },
  { name: 'error-handler' },
);
