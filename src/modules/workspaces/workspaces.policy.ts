import type { WorkspaceRole } from '../../generated/prisma/client.js';

/**
 * The whole permission model in one place.
 *
 * Keeping every rule here (instead of sprinkled through route handlers)
 * means you can read the security model in one screen, change it in one
 * place, and unit-test it without a database or HTTP.
 */

/** Higher number = more powerful. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export type Action =
  | 'workspace:read'
  | 'workspace:update'
  | 'workspace:delete'
  | 'members:read'
  | 'members:remove'
  | 'members:changeRole'
  | 'invitations:manage';

/** The minimum role needed for each action. */
export const MIN_ROLE: Record<Action, WorkspaceRole> = {
  'workspace:read': 'MEMBER',
  'workspace:update': 'ADMIN',
  'workspace:delete': 'OWNER',
  'members:read': 'MEMBER',
  'members:remove': 'ADMIN',
  'members:changeRole': 'OWNER',
  'invitations:manage': 'ADMIN',
};

export function can(role: WorkspaceRole, action: Action): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[MIN_ROLE[action]];
}

/**
 * The second rule: you can only act on people (or invitations) with a
 * LOWER role than yours. An admin can remove a member or invite a member,
 * but can't remove another admin, remove an owner, or invite an admin.
 * Owners can therefore never be removed by anyone but themselves.
 */
export function outranks(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
