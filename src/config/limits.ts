/**
 * Power of Ten rule 3, adapted: every resource a request can use has an
 * explicit upper bound (input size, time, database connections, quotas).
 * Nothing waits without limit, so one bad client (or one slow query) can't
 * take the whole service down. Stored history, such as old refresh tokens
 * and used invitations, still accumulates: LEARNING.md chapter 3 explains
 * the cleanup this will need.
 *
 * The fixed limits are here. The ones an operator may tune per deployment
 * (database pool size, quotas) are environment variables,
 * validated in env.ts with their own upper bounds.
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
  /** No list endpoint ever returns more items than this. */
  listMax: 1_000,
  /** Paginated lists: items per page when the client doesn't say, and the most it may ask for. */
  pageSizeDefault: 20,
  pageSizeMax: 100,
  /** A pagination cursor is a short opaque string; anything longer is rejected. */
  cursorMaxLength: 512,
  /**
   * The longest path parameter the router accepts (Fastify's maxParamLength):
   * our ids are 36 characters. A longer one gets 414 before any route runs.
   */
  pathParamChars: 100,
  /**
   * The most tasks a workspace can hold: MAX_PROJECTS_PER_WORKSPACE times
   * MAX_TASKS_PER_PROJECT may not be more. Removing a member unassigns all
   * their tasks in one statement, while the workspace is locked; for 100,000
   * tasks that took about 1.5 s, well inside the 10 s timeouts. Task lists
   * are paginated, so this bounds work and storage, not response size.
   */
  tasksPerWorkspaceMax: 100_000,
} as const;
