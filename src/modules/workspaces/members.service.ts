import type { FastifyInstance } from 'fastify';
import type { Membership, Prisma, User, WorkspaceRole } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import { can, outranks } from './workspaces.policy.js';
import {
  assertAnotherOwnerExists,
  checkWorkspaceHasOwner,
  lockWorkspace,
  requireMembership,
  requirePermission,
} from './workspaces.access.js';

function toMember(m: Membership & { user: User }) {
  return {
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.createdAt,
  };
}

export class MemberService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { maxMembersPerWorkspace: number },
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async list(workspaceId: string, userId: string) {
    await requirePermission(this.prisma, workspaceId, userId, 'members:read');
    const members = await this.prisma.membership.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      // The quota already bounds this list; `take` makes the bound explicit.
      take: this.opts.maxMembersPerWorkspace,
    });
    return members.map(toMember);
  }

  async changeRole(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Lock first, then read: everything below sees a stable picture of the
      // workspace, and no other membership change can sneak in until we commit.
      await lockWorkspace(tx, workspaceId);
      await requirePermission(tx, workspaceId, actorId, 'members:changeRole');

      const target = await tx.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (target === null) throw Errors.notFound('Member');

      if (target.role === 'OWNER' && role !== 'OWNER') {
        await assertAnotherOwnerExists(tx, workspaceId);
      }

      const updated = await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { role },
        include: { user: true },
      });
      await checkWorkspaceHasOwner(tx, workspaceId);
      return toMember(updated);
    });
  }

  /** Removing yourself is "leaving"; removing someone else needs permission. */
  async remove(workspaceId: string, actorId: string, targetUserId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const actor = await requireMembership(tx, workspaceId, actorId);

      if (targetUserId === actorId) {
        if (actor.role === 'OWNER') await assertAnotherOwnerExists(tx, workspaceId);
      } else {
        await this.assertCanRemoveOther(tx, workspaceId, actor.role, targetUserId);
      }

      await tx.membership.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      await checkWorkspaceHasOwner(tx, workspaceId);
    });
  }

  private async assertCanRemoveOther(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorRole: WorkspaceRole,
    targetUserId: string,
  ) {
    if (!can(actorRole, 'members:remove')) throw Errors.forbidden();
    const target = await tx.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
    if (target === null) throw Errors.notFound('Member');
    if (!outranks(actorRole, target.role)) {
      throw Errors.forbidden('You can only remove members with a lower role than yours');
    }
  }
}
