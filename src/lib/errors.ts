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
};
