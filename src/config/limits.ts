/**
 * Power of Ten rule 3, adapted: every resource a request can use has an
 * explicit upper bound, written down in one place (input size, time,
 * database connections). Nothing waits without limit, so one bad client
 * (or one slow query) can't take the whole service down. Stored history,
 * such as old refresh tokens, still accumulates: LEARNING.md chapter 3
 * explains the cleanup this will need.
 */
export const LIMITS = {
  /** Largest request body accepted. Our biggest JSON payload is well under 1 KB. */
  bodyBytes: 64 * 1024,
  /** Time allowed to receive a whole request (protects against very slow clients). */
  requestTimeoutMs: 30_000,
  /**
   * Time to wait for a free database connection before failing the request.
   * Also the time a transaction may wait to start.
   */
  dbConnectTimeoutMs: 5_000,
  /** Postgres cancels any single SQL statement that runs longer than this. */
  dbStatementTimeoutMs: 10_000,
  /**
   * A whole transaction, including any time spent waiting for a row lock,
   * must finish within this, or Prisma rolls it back and the request fails.
   */
  dbTransactionTimeoutMs: 10_000,
  /** Idle database connections are closed after this long. */
  dbIdleTimeoutMs: 30_000,
  /** If a graceful shutdown hasn't finished by then, exit anyway. */
  shutdownTimeoutMs: 10_000,
} as const;
