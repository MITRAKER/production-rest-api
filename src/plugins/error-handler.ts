import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

/** The status code Fastify (or a plugin) attached to an error, if any. */
function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    return typeof err.statusCode === 'number' ? err.statusCode : undefined;
  }
  return undefined;
}

/** A client error raised by Fastify itself, e.g. 415 bad content type or 429 rate limited. */
function frameworkClientError(err: unknown, status: number) {
  const message = err instanceof Error ? err.message : 'Bad request';
  if (status === 429) return { error: { code: 'RATE_LIMITED', message } };
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  return { error: { code: typeof code === 'string' ? code : 'BAD_REQUEST', message } };
}

/**
 * One place that turns every error into the same JSON shape:
 *
 *   { "error": { "code": "EMAIL_TAKEN", "message": "...", "details": [...] } }
 *
 * Unexpected errors are logged in full but the client only sees a generic
 * message, so we never leak stack traces or SQL to the outside world.
 */
export default fp(
  (app, _opts, done) => {
    app.setErrorHandler((err, request, reply) => {
      if (hasZodFastifySchemaValidationErrors(err)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: err.validation.map((v) => ({
              path: v.instancePath === '' ? '/' : v.instancePath,
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

      const status = statusCodeOf(err);
      if (status !== undefined && status >= 400 && status < 500) {
        return reply.code(status).send(frameworkClientError(err, status));
      }

      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      });
    });

    app.setNotFoundHandler((request, reply) => {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      });
    });

    done();
  },
  { name: 'error-handler' },
);
