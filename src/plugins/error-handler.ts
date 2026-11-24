import fp from 'fastify-plugin';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  ResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError, type ErrorCode } from '../lib/errors.js';

/** The status code Fastify (or a plugin) attached to an error, if any. */
function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    return typeof err.statusCode === 'number' ? err.statusCode : undefined;
  }
  return undefined;
}

/** Fastify's own code for an error, like FST_ERR_CTP_INVALID_JSON_BODY. */
function frameworkCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return typeof err.code === 'string' ? err.code : undefined;
  }
  return undefined;
}

/** Fastify's codes for a body that isn't valid JSON (including an empty one). */
const INVALID_JSON_CODES = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
]);

/**
 * Our code for a client error raised by Fastify or a plugin (a bad body, a
 * body too large, too many requests). Clients only ever see our codes, never
 * Fastify's: those are internal names that could change with any upgrade.
 */
function clientErrorCode(err: unknown, status: number): ErrorCode {
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  const code = frameworkCodeOf(err);
  return code !== undefined && INVALID_JSON_CODES.has(code) ? 'INVALID_JSON' : 'BAD_REQUEST';
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : 'Bad request';
}

/** The path of a URL, without its query string (which may hold anything). */
function pathOf(url: string) {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Answers an error that is neither ours (AppError) nor a validation error. A
 * client error that Fastify or a plugin raised keeps its status and gets one
 * of our codes. Anything else is a bug: logged in full, while the client
 * only sees a generic 500.
 */
function answerOtherError(err: unknown, request: FastifyRequest, reply: FastifyReply) {
  const status = statusCodeOf(err);
  if (status !== undefined && status >= 400 && status < 500) {
    const code = clientErrorCode(err, status);
    return reply.code(status).send({ error: { code, message: messageOf(err) } });
  }
  // A ResponseSerializationError means the handler answered something its
  // schema doesn't allow: a bug on our side. The log says what didn't match.
  const what =
    err instanceof ResponseSerializationError
      ? 'response does not match its schema'
      : 'unhandled error';
  request.log.error({ err }, what);
  return reply.code(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
}

/**
 * Fastify answers a few errors before it has even found the route: a URL
 * that isn't valid percent-encoding (400), or a path parameter (an id) longer
 * than maxParamLength (414). Those skip the error handler and every hook, so
 * buildApp gives this to Fastify as its `frameworkErrors` option.
 */
export function answerFrameworkError(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // The onSend hook that adds this header doesn't run for these errors.
  reply.header('x-request-id', request.id);
  void answerOtherError(err, request, reply);
}

/**
 * One place that turns every error into the same JSON shape (ErrorResponse
 * in src/lib/errors.ts):
 *
 *   { "error": { "code": "EMAIL_TAKEN", "message": "...", "details": [...] } }
 *
 * Unexpected errors are logged in full but the client only sees a generic
 * message, so we never leak stack traces or SQL to the outside world.
 */
export default fp(
  (app, _opts, done) => {
    app.setErrorHandler((err: FastifyError, request, reply) => {
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
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }

      return answerOtherError(err, request, reply);
    });

    app.setNotFoundHandler((request, reply) => {
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${pathOf(request.url)} not found`,
        },
      });
    });

    done();
  },
  { name: 'error-handler' },
);
