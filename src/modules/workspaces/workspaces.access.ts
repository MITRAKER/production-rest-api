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
 * The first of the two numbers that name a workspace's lock. Advisory locks
 * are named by numbers we choose: this one says "a workspace", the second one
 * (a hash of its id) says which. Other kinds of advisory locks would use
 * another first number, so they can never collide with these.
 */
const WORKSPACE_LOCK = 1;

/** 404 unless the workspace exists. Under its lock, nobody can delete it before we commit. */
async function requireWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  });
  if (workspace === null) throw Errors.notFound('Workspace');
}

/**
 * Locks the workspace until the surrounding transaction ends (exclusive).
 *
 * Every operation that changes who is in a workspace (or with which role),
 * renames or deletes it, or counts its projects takes this lock first, so
 * those operations run one at a time per workspace. That's what makes rules
 * like "there is always at least one owner" safe even when two requests
 * arrive at the same instant.
 *
 * It's an advisory lock: a lock on a number, here the workspace's, managed by
 * Postgres like any other lock and released at COMMIT or ROLLBACK. Two
 * workspaces whose ids hash to the same number would wait for each other now
 * and then: slower, never wrong. Unlike a row lock (FOR UPDATE, FOR SHARE),
 * it waits in a fair queue: see lockWorkspaceShared().
 *
 * Prisma has no API for locks, so this is one of the rare raw SQL queries.
 * `${workspaceId}` is a bind parameter, and `::uuid::text` turns any spelling
 * of the id into the one canonical text, so every caller hashes the same.
 */
export async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${WORKSPACE_LOCK}::int, hashtext(${workspaceId}::uuid::text))`;
  await requireWorkspace(tx, workspaceId);
}

/**
 * The shared version of lockWorkspace(), for writes INSIDE a workspace
 * (projects and tasks).
 *
 * Any number of transactions can hold this lock at once, so task edits don't
 * wait for each other. But it conflicts with lockWorkspace(): while one is
 * held, nobody's membership or role can change. That keeps true, until we
 * commit, what we checked at the start: that the caller is still a member
 * with the right role, and that a new assignee is still a member.
 *
 * Why not a row lock (SELECT ... FOR SHARE)? Postgres row locks don't queue
 * fairly: a new FOR SHARE joins the transactions that already share the row
 * at once, even while a FOR UPDATE is waiting for them to finish. With a
 * steady stream of task edits, there is never a moment when nobody holds the
 * shared lock, so the exclusive one waited until its 10-second timeout (the
 * second review of step 5 measured it: three members editing one task in a
 * loop could block their own removal). Advisory locks wait in line: once an
 * exclusive request is waiting, new shared requests wait behind it.
 *
 * Lock order: the workspace first, then a project (lockProject) or a task,
 * then users.
 */
export async function lockWorkspaceShared(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(${WORKSPACE_LOCK}::int, hashtext(${workspaceId}::uuid::text))`;
  await requireWorkspace(tx, workspaceId);
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
