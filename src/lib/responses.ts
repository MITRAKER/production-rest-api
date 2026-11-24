import type { z } from 'zod';
import { ErrorResponse } from './errors.js';

/**
 * One kind of error answer: what it means, and a typical body. The docs show
 * the example (without one, they would show the first code of the list,
 * VALIDATION_ERROR, under every status). The type checks it: an example
 * can't use a code that isn't in ERROR_CODES.
 */
function errorAnswer(description: string, example: z.infer<typeof ErrorResponse>['error']) {
  return ErrorResponse.meta({ description, examples: [{ error: example }] });
}

/**
 * The error answers a route can give. A route lists the ones its own logic
 * produces:
 *
 *   response: { 200: Task, ...errorResponses(400, 401, 404) }
 *
 * and every route also gets `default`, for the errors any route can give
 * (a body that's too large, a server error...).
 *
 * These schemas aren't only documentation. Fastify checks every answer
 * against the schema for its status before sending it, so an error body that
 * doesn't have the documented shape, or a code that isn't in ERROR_CODES,
 * fails loudly in the tests instead of surprising a client.
 */
const ERROR_ANSWERS = {
  400: errorAnswer('The request is invalid. VALIDATION_ERROR lists each problem in error.details', {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: [{ path: '/email', message: 'Invalid email address' }],
  }),
  401: errorAnswer('Not logged in, or the email, password or token sent is wrong', {
    code: 'UNAUTHORIZED',
    message: 'Authentication required',
  }),
  403: errorAnswer('Not allowed, though you can see it: error.message says why', {
    code: 'FORBIDDEN',
    message: 'You do not have permission to do this',
  }),
  404: errorAnswer('Not found, or not visible to you: outsiders get 404, never 403', {
    code: 'NOT_FOUND',
    message: 'Workspace not found',
  }),
  409: errorAnswer('Conflicts with what is already there, or a quota is full', {
    code: 'LIMIT_REACHED',
    message: 'A workspace can have at most 20 projects',
  }),
  410: errorAnswer('The invitation expired or was already used', {
    code: 'INVITATION_EXPIRED',
    message: 'This invitation has expired or was already used',
  }),
  429: errorAnswer('Too many attempts: wait a minute and try again', {
    code: 'RATE_LIMITED',
    message: 'Rate limit exceeded, retry in 1 minute',
  }),
} as const;

const ANY_ROUTE = errorAnswer(
  'Any other error, such as PAYLOAD_TOO_LARGE (413), UNSUPPORTED_MEDIA_TYPE (415) ' +
    'or INTERNAL_ERROR (500)',
  { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
);

export type ErrorStatus = keyof typeof ERROR_ANSWERS;

export function errorResponses<S extends ErrorStatus>(
  ...statuses: S[]
): Pick<typeof ERROR_ANSWERS, S> & { default: typeof ANY_ROUTE } {
  const picked = Object.fromEntries(statuses.map((status) => [status, ERROR_ANSWERS[status]]));
  return { ...(picked as Pick<typeof ERROR_ANSWERS, S>), default: ANY_ROUTE };
}
