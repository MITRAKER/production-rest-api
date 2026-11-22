import type { FastifyInstance } from 'fastify';
import type { Prisma, Task } from '../../generated/prisma/client.js';
import { dateFromIso, isoFromDate } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import {
  cursorDate,
  cursorDateTime,
  decodeCursor,
  toPage,
  type Cursor,
  type SortOrder,
} from '../../lib/pagination.js';
import { lockProject, requireProject, type ProjectRef } from '../projects/projects.access.js';
import {
  lockWorkspaceShared,
  requireMembership,
  requirePermission,
} from '../workspaces/workspaces.access.js';
import { can } from '../workspaces/workspaces.policy.js';
import {
  afterTimestamp,
  datedAfter,
  dueDateOrder,
  taskCursor,
  taskFilters,
  taskListScope,
  timestampOrder,
  undatedAfter,
} from './tasks.query.js';
import type { CreateTaskBody, TaskListQuery, UpdateTaskBody } from './tasks.schemas.js';

/** The ids in a task's URL: /workspaces/:workspaceId/projects/:projectId/tasks/:taskId. */
export interface TaskRef extends ProjectRef {
  taskId: string;
}

type Where = Prisma.TaskWhereInput;

/** The task as the API returns it: the due date as "2026-12-31", not a timestamp. */
function toTaskDto(task: Task) {
  return { ...task, dueDate: task.dueDate === null ? null : isoFromDate(task.dueDate) };
}

/** Only the fields that were sent: PATCH leaves the others as they are, and null clears. */
function taskChanges(body: UpdateTaskBody): Prisma.TaskUncheckedUpdateInput {
  const data: Prisma.TaskUncheckedUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;
  if (body.status !== undefined) data.status = body.status;
  if (body.priority !== undefined) data.priority = body.priority;
  if (body.dueDate !== undefined) {
    data.dueDate = body.dueDate === null ? null : dateFromIso(body.dueDate);
  }
  if (body.assigneeId !== undefined) data.assigneeId = body.assigneeId;
  return data;
}

/**
 * A task can only be assigned to a member of its workspace (400 otherwise).
 * Call it under lockWorkspaceShared: then the assignee can't be removed from
 * the workspace before we commit.
 */
async function assertAssignable(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  const membership = await tx.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (membership === null) throw Errors.assigneeNotMember();
}

/**
 * Locks the task row until the transaction ends, looked up by all three ids
 * from the URL (404 if they don't match one task). Returns its creator, for
 * the delete rule.
 */
async function lockTask(tx: Prisma.TransactionClient, ref: TaskRef) {
  const rows = await tx.$queryRaw<{ createdById: string | null }[]>`
    SELECT created_by_id AS "createdById" FROM tasks
    WHERE id = ${ref.taskId}::uuid
      AND project_id = ${ref.projectId}::uuid
      AND workspace_id = ${ref.workspaceId}::uuid
    FOR UPDATE`;
  const task = rows[0];
  if (task === undefined) throw Errors.notFound('Task');
  return task;
}

export class TaskService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { maxTasksPerProject: number },
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async create(ref: ProjectRef, userId: string, body: CreateTaskBody) {
    return this.prisma.$transaction(async (tx) => {
      // Lock, check, write. The shared workspace lock keeps memberships and
      // roles as they are until we commit; the project lock makes task
      // creations in this project run one at a time, so the count holds.
      await lockWorkspaceShared(tx, ref.workspaceId);
      await requirePermission(tx, ref.workspaceId, userId, 'tasks:write');
      await lockProject(tx, ref);

      const max = this.opts.maxTasksPerProject;
      const count = await tx.task.count({ where: { projectId: ref.projectId } });
      if (count >= max) {
        throw Errors.limitReached(`A project can have at most ${String(max)} tasks`);
      }
      if (body.assigneeId !== null) await assertAssignable(tx, ref.workspaceId, body.assigneeId);

      const task = await tx.task.create({
        data: {
          ...body,
          dueDate: body.dueDate === null ? null : dateFromIso(body.dueDate),
          workspaceId: ref.workspaceId,
          projectId: ref.projectId,
          createdById: userId,
        },
      });
      return toTaskDto(task);
    });
  }

  async list(ref: ProjectRef, userId: string, query: TaskListQuery) {
    await requireMembership(this.prisma, ref.workspaceId, userId);
    await requireProject(this.prisma, ref);

    const key = { scope: taskListScope(ref.projectId), sort: query.sort, order: query.order };
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, key);
    const where: Where = {
      AND: [{ projectId: ref.projectId, workspaceId: ref.workspaceId }, ...taskFilters(query)],
    };
    // One more than the page size: if it comes back, there is a next page.
    const take = query.limit + 1;
    const rows =
      query.sort === 'dueDate'
        ? await this.pageByDueDate(where, query.order, cursor, take)
        : await this.prisma.task.findMany({
            where: {
              AND: [
                where,
                cursor === null
                  ? {}
                  : afterTimestamp(query.sort, query.order, cursorDateTime(cursor), cursor.id),
              ],
            },
            orderBy: timestampOrder(query.sort, query.order),
            take,
          });

    const page = toPage(rows, query.limit, (last) => taskCursor(last, query.sort, query.order));
    return { data: page.data.map(toTaskDto), nextCursor: page.nextCursor };
  }

  /**
   * One page sorted by due date, with the tasks that have none at the end
   * (in either order). Instead of one query with an OR, which no index can
   * serve in order, it reads two index ranges: first the dated tasks after
   * the cursor, then, if the page isn't full yet, the undated ones.
   */
  private async pageByDueDate(where: Where, order: SortOrder, cursor: Cursor | null, take: number) {
    if (cursor === null)
      return this.datedThenUndated(where, { dueDate: { not: null } }, order, take);
    const value = cursorDate(cursor);
    if (value === null) {
      // The previous page already ended among the undated tasks.
      return this.prisma.task.findMany({
        where: { AND: [where, undatedAfter(order, cursor.id)] },
        orderBy: dueDateOrder(order),
        take,
      });
    }
    return this.datedThenUndated(where, datedAfter(order, value, cursor.id), order, take);
  }

  /**
   * The two reads share one REPEATABLE READ transaction, so both see the
   * table as it was at the first one. As two separate statements, each would
   * see the latest commits: a task whose due date is set or cleared between
   * them would be on the page twice, or not at all.
   */
  private async datedThenUndated(where: Where, dated: Where, order: SortOrder, take: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const first = await tx.task.findMany({
          where: { AND: [where, dated] },
          orderBy: dueDateOrder(order),
          take,
        });
        if (first.length === take) return first;
        const rest = await tx.task.findMany({
          where: { AND: [where, { dueDate: null }] },
          orderBy: dueDateOrder(order),
          take: take - first.length,
        });
        return [...first, ...rest];
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async get(ref: TaskRef, userId: string) {
    await requireMembership(this.prisma, ref.workspaceId, userId);
    const task = await this.prisma.task.findFirst({
      where: { id: ref.taskId, projectId: ref.projectId, workspaceId: ref.workspaceId },
    });
    if (task === null) throw Errors.notFound('Task');
    return toTaskDto(task);
  }

  async update(ref: TaskRef, userId: string, body: UpdateTaskBody) {
    return this.prisma.$transaction(async (tx) => {
      await lockWorkspaceShared(tx, ref.workspaceId);
      await requirePermission(tx, ref.workspaceId, userId, 'tasks:write');
      await lockTask(tx, ref);
      if (body.assigneeId !== undefined && body.assigneeId !== null) {
        await assertAssignable(tx, ref.workspaceId, body.assigneeId);
      }
      const task = await tx.task.update({ where: { id: ref.taskId }, data: taskChanges(body) });
      return toTaskDto(task);
    });
  }

  async delete(ref: TaskRef, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockWorkspaceShared(tx, ref.workspaceId);
      const membership = await requireMembership(tx, ref.workspaceId, userId);
      const task = await lockTask(tx, ref);
      // Ownership-based permission: you may always delete a task you
      // created. Deleting someone else's takes a role (admins and owners).
      if (task.createdById !== userId && !can(membership.role, 'tasks:deleteAny')) {
        throw Errors.forbidden('Only the creator of a task, or an admin, can delete it');
      }
      await tx.task.delete({ where: { id: ref.taskId } });
    });
  }
}
