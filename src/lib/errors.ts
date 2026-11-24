import { z } from 'zod';

/**
 * Every error code the API answers with. A code is part of the API: clients
 * switch on it, so once released it never changes. The message is for
 * people and may change wording.
 *
 * The OpenAPI document lists these codes (the Error schema), and every
 * documented error response is checked against that schema before it's
 * sent, so the API can't answer with a code that isn't in this list.
 */
export const ERROR_CODES = [
  // 400: the request itself is wrong
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'BAD_REQUEST',
  'INVALID_CURSOR',
  'ASSIGNEE_NOT_MEMBER',
  // 401: we don't know who you are
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'INVALID_REFRESH_TOKEN',
  // 403: we know, and you may not do this
  'FORBIDDEN',
  'INVITATION_EMAIL_MISMATCH',
  // 404 and 410: it isn't there, or not any more
  'NOT_FOUND',
  'INVITATION_NOT_FOUND',
  'INVITATION_EXPIRED',
  // 409: it conflicts with what's already there
  'EMAIL_TAKEN',
  'LAST_OWNER',
  'ALREADY_MEMBER',
  'INVITATION_PENDING',
  'LIMIT_REACHED',
  // 413, 415 and 429: limits of the HTTP layer
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  // 500: our fault
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** What is wrong with one field, in a VALIDATION_ERROR. */
const FieldError = z.object({
  path: z
    .string()
    .describe('Where the problem is, as a JSON Pointer: "/email", or "/" for the whole input'),
  message: z.string(),
});

/** The body of every error response: `{ "error": { "code", "message", "details"? } }`. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).describe('What went wrong, for programs: switch on this'),
      message: z.string().describe('What went wrong, for people: the wording may change'),
      details: z
        .array(FieldError)
        .optional()
        .describe('Only for VALIDATION_ERROR: one entry per problem'),
    }),
  })
  .meta({ id: 'Error', description: 'The body of every error answer' });

/**
 * An error we throw on purpose, with an HTTP status and a stable,
 * machine-readable code. Clients should switch on `code`, never on `message`
 * (messages are for humans and may change wording).
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
  invalidRefreshToken: () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired'),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists'),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  forbidden: (message = 'You do not have permission to do this') =>
    new AppError(403, 'FORBIDDEN', message),
  lastOwner: () =>
    new AppError(
      409,
      'LAST_OWNER',
      'A workspace must always have at least one owner. Make someone else an owner first.',
    ),
  alreadyMember: () =>
    new AppError(409, 'ALREADY_MEMBER', 'This person is already a member of the workspace'),
  invitationPending: () =>
    new AppError(
      409,
      'INVITATION_PENDING',
      'This email already has a pending invitation. Revoke it first to send a new one.',
    ),
  invitationNotFound: () => new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation not found'),
  /** A configured quota (Power of Ten rule 3) would be exceeded. */
  limitReached: (message: string) => new AppError(409, 'LIMIT_REACHED', message),
  invitationExpired: () =>
    new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired or was already used'),
  invalidCursor: () =>
    new AppError(
      400,
      'INVALID_CURSOR',
      'The cursor is invalid or belongs to a different sort order. Start again from the first page.',
    ),
  assigneeNotMember: () =>
    new AppError(400, 'ASSIGNEE_NOT_MEMBER', 'Tasks can only be assigned to workspace members'),
  invitationEmailMismatch: () =>
    new AppError(
      403,
      'INVITATION_EMAIL_MISMATCH',
      'This invitation was sent to a different email address',
    ),
};
