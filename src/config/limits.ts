/**
 * Power of Ten rule 3, adapted: every resource the server uses has an
 * explicit upper bound, written down in one place. Nothing grows or waits
 * without limit, so one bad client (or one slow query) can't take the
 * whole service down.
 */
export const LIMITS = {
  /** Largest request body accepted. Our biggest JSON payload is well under 1 KB. */
  bodyBytes: 64 * 1024,
  /** Time allowed to receive a whole request (protects against very slow clients). */
  requestTimeoutMs: 30_000,
  /** Time to wait for a free database connection before failing the request. */
  dbConnectTimeoutMs: 5_000,
  /** Postgres cancels any single SQL statement that runs longer than this. */
  dbStatementTimeoutMs: 10_000,
  /** Idle database connections are closed after this long. */
  dbIdleTimeoutMs: 30_000,
  /** If a graceful shutdown hasn't finished by then, exit anyway. */
  shutdownTimeoutMs: 10_000,
} as const;
