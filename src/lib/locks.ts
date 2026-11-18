import type { Prisma } from '../generated/prisma/client.js';
import { Errors } from './errors.js';

/**
 * Locks the user's row until the surrounding transaction ends.
 *
 * Two transactions that both start with this lock for the same user run
 * one after the other instead of interleaving. The second one waits, then
 * sees everything the first one committed. Refresh token rotation and
 * session revocation take it, so a logout can't miss the new token that a
 * refresh is creating at the same moment.
 *
 * Prisma has no API for row locks, so this is one of the rare raw SQL
 * queries. It is parameterized like every other query: `${userId}` becomes
 * a bind parameter, never part of the SQL text.
 */
export async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw Errors.unauthorized();
}
