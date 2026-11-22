import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { Errors } from '../../lib/errors.js';
import { invariant } from '../../lib/invariant.js';
import { can, type Action } from './workspaces.policy.js';

/**
 * Returns the caller's membership in the workspace.
 *
 * If they're not a member we answer 404, not 403: an outsider shouldn't
 * even be able to learn that a workspace with this id exists.
 */
export async function requireMembership(db: Db, workspaceId: string, userId: string) {
  const membership = await db.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (membership === null) throw Errors.notFound('Workspace');
  return membership;
}

/** Membership check (404 for outsiders) + role check (403 for members without permission). */
export async function requirePermission(
  db: Db,
  workspaceId: string,
  userId: string,
  action: Action,
) {
  const membership = await requireMembership(db, workspaceId, userId);
  if (!can(membership.role, action)) throw Errors.forbidden();
  return membership;
}

/**
 * Locks the workspace row until the surrounding transaction ends.
 *
 * Every operation that changes who is in a workspace (or with which role)
 * takes this lock first, so those operations run one at a time per
 * workspace. That's what makes rules like "there is always at least one
 * owner" safe even when two requests arrive at the same instant.
 * Prisma has no API for row locks, so this is one of the rare raw SQL queries.
 */
export async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw Errors.notFound('Workspace');
}

/**
 * Throws LIMIT_REACHED if the user already belongs to `max` workspaces.
 * Call it under lockUser() (src/lib/locks.ts), so two simultaneous requests
 * can't both pass the "fewer than the maximum" check (the same race as the
 * last-owner one).
 */
export async function assertCanJoinAnotherWorkspace(
  tx: Prisma.TransactionClient,
  userId: string,
  max: number,
) {
  const count = await tx.membership.count({ where: { userId } });
  if (count >= max) {
    throw Errors.limitReached(`A user can belong to at most ${String(max)} workspaces`);
  }
}

/** Throws LAST_OWNER unless the workspace has more than one owner. Call under lockWorkspace. */
export async function assertAnotherOwnerExists(tx: Prisma.TransactionClient, workspaceId: string) {
  const owners = await tx.membership.count({ where: { workspaceId, role: 'OWNER' } });
  if (owners <= 1) throw Errors.lastOwner();
}

/**
 * Post-condition (Power of Ten rule 5), checked after every membership change:
 * a workspace always has an owner. assertAnotherOwnerExists() should make
 * this impossible, so a failure here is a bug in our code. It throws inside
 * the transaction, which rolls the change back.
 */
export async function checkWorkspaceHasOwner(tx: Prisma.TransactionClient, workspaceId: string) {
  const owners = await tx.membership.count({ where: { workspaceId, role: 'OWNER' } });
  invariant(owners >= 1, `workspace ${workspaceId} would be left without an owner`);
}
