/**
 * Power of Ten rule 5: assert what must always be true.
 *
 * Use invariant() for conditions that can only fail if OUR code has a bug
 * (user input is validated separately, by Zod schemas). Assertions must
 * have no side effects. When one fails we throw: the request ends with a
 * 500, the error is logged with its message, and any open database
 * transaction is rolled back, so the bug can't leave bad data behind.
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError';
}

/** The condition must be an explicit boolean, e.g. invariant(rows.length === 1, '...'). */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new InvariantError(`Invariant violated: ${message}`);
  }
}
