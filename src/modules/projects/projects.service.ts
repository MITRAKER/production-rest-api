import type { FastifyInstance } from 'fastify';
import type { Prisma, Project } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import {
  cursorDateTime,
  decodeCursor,
  encodeCursor,
  toPage,
  type PageQuery,
} from '../../lib/pagination.js';
import {
  lockWorkspace,
  lockWorkspaceShared,
  requireMembership,
  requirePermission,
} from '../workspaces/workspaces.access.js';
import { lockProject, requireProject, type ProjectRef } from './projects.access.js';
import type { UpdateProjectBody } from './projects.schemas.js';

/** Projects are listed oldest first, with the id as tiebreaker. */
const SORT = 'createdAt';

/** A cursor names its list: the projects of one workspace. */
const listScope = (workspaceId: string) => `projects:${workspaceId}`;

function projectCursor(project: Project): string {
  const scope = listScope(project.workspaceId);
  const value = project.createdAt.toISOString();
  return encodeCursor({ scope, sort: SORT, order: 'asc', value, id: project.id });
}

/**
 * The projects after the cursor. "createdAt >= v AND (createdAt > v OR id > id0)"
 * selects the same rows as "createdAt > v OR (createdAt = v AND id > id0)",
 * but its first half tells Postgres where to start reading the index.
 */
function afterCursor(workspaceId: string, raw: string | undefined): Prisma.ProjectWhereInput {
  if (raw === undefined) return {};
  const cursor = decodeCursor(raw, { scope: listScope(workspaceId), sort: SORT, order: 'asc' });
  const createdAt = cursorDateTime(cursor);
  return {
    AND: [
      { createdAt: { gte: createdAt } },
      { OR: [{ createdAt: { gt: createdAt } }, { id: { gt: cursor.id } }] },
    ],
  };
}

/** Only the fields that were sent: PATCH leaves the others as they are. */
function projectChanges(body: UpdateProjectBody): Prisma.ProjectUpdateInput {
  const data: Prisma.ProjectUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  return data;
}

export class ProjectService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { maxProjectsPerWorkspace: number },
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async create(workspaceId: string, userId: string, body: { name: string; description: string }) {
    return this.prisma.$transaction(async (tx) => {
      // The exclusive lock: two admins creating the last allowed project at
      // the same moment run one after the other, so the count stays true.
      await lockWorkspace(tx, workspaceId);
      await requirePermission(tx, workspaceId, userId, 'projects:manage');

      const max = this.opts.maxProjectsPerWorkspace;
      const count = await tx.project.count({ where: { workspaceId } });
      if (count >= max) {
        throw Errors.limitReached(`A workspace can have at most ${String(max)} projects`);
      }
      return tx.project.create({ data: { ...body, workspaceId, createdById: userId } });
    });
  }

  async list(workspaceId: string, userId: string, query: PageQuery) {
    await requireMembership(this.prisma, workspaceId, userId);
    const rows = await this.prisma.project.findMany({
      where: { AND: [{ workspaceId }, afterCursor(workspaceId, query.cursor)] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      // One more than the page size: if it comes back, there is a next page.
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, projectCursor);
  }

  async get(ref: ProjectRef, userId: string) {
    await requireMembership(this.prisma, ref.workspaceId, userId);
    return requireProject(this.prisma, ref);
  }

  async update(ref: ProjectRef, userId: string, body: UpdateProjectBody) {
    return this.prisma.$transaction(async (tx) => {
      // Lock, check, write: under these locks the caller's role and the
      // project can't change (or disappear) between our checks and the update.
      await lockWorkspaceShared(tx, ref.workspaceId);
      await requirePermission(tx, ref.workspaceId, userId, 'projects:manage');
      await lockProject(tx, ref);
      return tx.project.update({ where: { id: ref.projectId }, data: projectChanges(body) });
    });
  }

  async delete(ref: ProjectRef, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockWorkspaceShared(tx, ref.workspaceId);
      await requirePermission(tx, ref.workspaceId, userId, 'projects:manage');
      await lockProject(tx, ref);
      // Its tasks are deleted with it, by ON DELETE CASCADE.
      await tx.project.delete({ where: { id: ref.projectId } });
    });
  }
}
