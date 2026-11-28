import fp from 'fastify-plugin';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  ResponseSerializationError,
} from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { LIMITS } from '../config/limits.js';
import { AppError, ErrorResponse, type ErrorCode } from '../lib/errors.js';

type ErrorBody = z.infer<typeof ErrorResponse>;

const INTERNAL_ERROR: ErrorBody = {
  error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
};

/**
 * Sends an error answer, after checking it against the Error schema.
 *
 * Fastify checks it again against the route's schema, but too late to help:
 * Fastify runs our error handler only once per request, so a failure there
 * would go to Fastify's own error handler, which answers in its own shape
 * (FST_ERR_FAILED_ERROR_SERIALIZATION). Checked here, an answer that doesn't
 * fit, such as an AppError with a code that isn't in the catalog, becomes our
 * generic 500, and the log says why.
 */
function sendError(reply: FastifyReply, status: number, body: ErrorBody, cause?: unknown) {
  const checked = ErrorResponse.safeParse(body);
  if (checked.success) return reply.code(status).send(checked.data);
  const issues = checked.error.issues;
  reply.log.error({ err: cause, status, issues }, 'response does not match its schema');
  return reply.code(500).send(INTERNAL_ERROR);
}

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

/** Our code for each status that Fastify or a plugin may answer with. */
const CODE_FOR_STATUS = new Map<number, ErrorCode>([
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [415, 'UNSUPPORTED_MEDIA_TYPE'],
  [429, 'RATE_LIMITED'],
]);

/**
 * Our code for a client error raised by Fastify or a plugin (a bad body, a
 * body too large, too many requests). Clients only ever see our codes, never
 * Fastify's: those are internal names that could change with any upgrade. So
 * this goes by the HTTP status, and reads Fastify's code only to tell the
 * JSON errors apart from the other 400s.
 */
function clientErrorCode(err: unknown, status: number): ErrorCode {
  const code = frameworkCodeOf(err);
  if (code !== undefined && INVALID_JSON_CODES.has(code)) return 'INVALID_JSON';
  return CODE_FOR_STATUS.get(status) ?? 'BAD_REQUEST';
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
function answerOtherError(err: unknown, reply: FastifyReply) {
  const status = statusCodeOf(err);
  if (status !== undefined && status >= 400 && status < 500) {
    const code = clientErrorCode(err, status);
    return sendError(reply, status, { error: { code, message: messageOf(err) } }, err);
  }
  // A ResponseSerializationError means the handler answered something its
  // schema doesn't allow: a bug on our side. The log says what didn't match.
  const what =
    err instanceof ResponseSerializationError
      ? 'response does not match its schema'
      : 'unhandled error';
  reply.log.error({ err }, what);
  return reply.code(500).send(INTERNAL_ERROR);
}

/**
 * Fastify answers a few errors before it has even found the route: a URL
 * that isn't valid percent-encoding (400), or a path parameter (an id)
 * longer than maxParamLength (414). Those skip the error handler and every
 * hook, so buildApp gives this to Fastify as its `frameworkErrors` option.
 */
export function answerFrameworkError(
  err: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // The onSend hook that adds this header doesn't run for these errors.
  reply.header('x-request-id', request.id);
  const status = statusCodeOf(err);
  if (status !== 400 && status !== 414) {
    void answerOtherError(err, reply);
    return;
  }
  // Our own words: Fastify's message repeats the whole URL, query string included.
  const message =
    status === 414
      ? `An id in the path is longer than ${String(LIMITS.pathParamChars)} characters`
      : `The URL ${pathOf(request.url)} is not valid`;
  void sendError(reply, status, { error: { code: 'BAD_REQUEST', message } }, err);
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
    app.setErrorHandler((err: FastifyError, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(err)) {
        return sendError(reply, 400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: err.validation.map((v) => ({
              path: v.instancePath === '' ? '/' : v.instancePath,
              message: v.message ?? 'Invalid value',
            })),
          },
        });
      }

      if (err instanceof AppError) {
        const body = { error: { code: err.code, message: err.message } };
        return sendError(reply, err.statusCode, body, err);
      }

      return answerOtherError(err, reply);
    });

    app.setNotFoundHandler((request, reply) => {
      const message = `Route ${request.method} ${pathOf(request.url)} not found`;
      return sendError(reply, 404, { error: { code: 'NOT_FOUND', message } });
    });

    done();
  },
  { name: 'error-handler' },
);
