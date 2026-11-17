import type { FastifyInstance } from 'fastify';
import { Errors } from '../../lib/errors.js';
import { lockUser } from '../../lib/locks.js';
import {
  assertCanJoinAnotherWorkspace,
  lockWorkspace,
  requirePermission,
} from './workspaces.access.js';

export class WorkspaceService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { maxWorkspacesPerUser: number },
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async create(userId: string, name: string) {
    return this.prisma.$transaction(async (tx) => {
      // Power of Ten rule 3: a user can't create workspaces without limit.
      await lockUser(tx, userId);
      await assertCanJoinAnotherWorkspace(tx, userId, this.opts.maxWorkspacesPerUser);

      // A nested write: the workspace and the creator's OWNER membership are
      // inserted together. There's never a moment where the workspace
      // exists without an owner.
      const workspace = await tx.workspace.create({
        data: { name, memberships: { create: { userId, role: 'OWNER' } } },
      });
      return { ...workspace, role: 'OWNER' as const };
    });
  }

  async listForUser(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
      // The quota already bounds this list; `take` makes the bound explicit.
      take: this.opts.maxWorkspacesPerUser,
    });
    return memberships.map((m) => ({ ...m.workspace, role: m.role }));
  }

  async get(workspaceId: string, userId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: true },
    });
    if (membership === null) throw Errors.notFound('Workspace');
    return { ...membership.workspace, role: membership.role };
  }

  async update(workspaceId: string, userId: string, data: { name: string }) {
    const membership = await requirePermission(
      this.prisma,
      workspaceId,
      userId,
      'workspace:update',
    );
    const workspace = await this.prisma.workspace.update({ where: { id: workspaceId }, data });
    return { ...workspace, role: membership.role };
  }

  async delete(workspaceId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      await requirePermission(tx, workspaceId, userId, 'workspace:delete');
      // Memberships and invitations are removed by ON DELETE CASCADE.
      await tx.workspace.delete({ where: { id: workspaceId } });
    });
  }
}
