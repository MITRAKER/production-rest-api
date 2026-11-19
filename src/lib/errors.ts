/**
 * An error we throw on purpose, with an HTTP status and a stable,
 * machine-readable code. Clients should switch on `code`, never on `message`
 * (messages are for humans and may change wording).
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
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
  invitationEmailMismatch: () =>
    new AppError(
      403,
      'INVITATION_EMAIL_MISMATCH',
      'This invitation was sent to a different email address',
    ),
};
