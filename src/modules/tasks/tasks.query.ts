import type { Prisma, Task } from '../../generated/prisma/client.js';
import { dateFromIso, isoFromDate } from '../../lib/dates.js';
import { encodeCursor, type SortOrder } from '../../lib/pagination.js';
import type { TaskListQuery, TaskSort } from './tasks.schemas.js';

/**
 * The pieces of the task list query: filters, sort order, and "the rows after
 * the cursor". Pure functions with no database access, so each piece is easy
 * to read and to test on its own. TaskService.list puts them together.
 */

type Where = Prisma.TaskWhereInput;
type TimestampSort = Exclude<TaskSort, 'dueDate'>;

/**
 * Escapes the characters that LIKE treats specially. Prisma's `contains`
 * becomes `ILIKE '%' || value || '%'` and does NOT escape the value, so
 * without this a search for "100%" would also match "100 apples" (% means
 * "anything"), and "a_b" would match "axb" (_ means "any one character").
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/** The filters from the query string. The list keeps the tasks that match all of them. */
export function taskFilters(query: TaskListQuery): Where[] {
  const filters: Where[] = [];
  if (query.status !== undefined) filters.push({ status: { in: query.status } });
  if (query.priority !== undefined) filters.push({ priority: { in: query.priority } });
  if (query.assigneeId !== undefined) {
    filters.push({ assigneeId: query.assigneeId === 'none' ? null : query.assigneeId });
  }
  if (query.dueFrom !== undefined) filters.push({ dueDate: { gte: dateFromIso(query.dueFrom) } });
  if (query.dueTo !== undefined) filters.push({ dueDate: { lte: dateFromIso(query.dueTo) } });
  if (query.q !== undefined) {
    filters.push({ title: { contains: escapeLike(query.q), mode: 'insensitive' } });
  }
  return filters;
}

function onTimestamp(sort: TimestampSort, filter: Prisma.DateTimeFilter<'Task'>): Where {
  return sort === 'createdAt' ? { createdAt: filter } : { updatedAt: filter };
}

/** ORDER BY createdAt (or updatedAt), then id, both in the same direction. */
export function timestampOrder(sort: TimestampSort, order: SortOrder) {
  const first: Prisma.TaskOrderByWithRelationInput =
    sort === 'createdAt' ? { createdAt: order } : { updatedAt: order };
  return [first, { id: order }];
}

/**
 * ORDER BY dueDate, then id: for both parts of a due-date list, the tasks with
 * a due date and those without. For the second part every due date is NULL,
 * so this is simply "by id", and yet the dueDate must stay. Postgres treats a
 * column as fixed only when it's compared with "=", and "due_date IS NULL"
 * isn't one: ordered by id alone, it doesn't see that the (project_id,
 * due_date, id) index already holds those tasks in id order, and walks the
 * primary key through the tasks of every project instead (measured: 1,924
 * rows read and thrown away for a page of 21). With the dueDate, it reads
 * exactly the stretch of undated tasks.
 */
export function dueDateOrder(order: SortOrder): Prisma.TaskOrderByWithRelationInput[] {
  return [{ dueDate: order }, { id: order }];
}

/**
 * The tasks after the position (value, id), sorted by a column that is never
 * null. "column >= v AND (column > v OR id > id0)" selects the same rows as
 * the shorter "column > v OR (column = v AND id > id0)", but its first half
 * gives Postgres a place to start reading the index. For descending order,
 * every comparison flips.
 */
export function afterTimestamp(sort: TimestampSort, order: SortOrder, value: Date, id: string) {
  const asc = order === 'asc';
  const from: Prisma.DateTimeFilter<'Task'> = asc ? { gte: value } : { lte: value };
  const past: Prisma.DateTimeFilter<'Task'> = asc ? { gt: value } : { lt: value };
  const pastId: Prisma.UuidFilter<'Task'> = asc ? { gt: id } : { lt: id };
  return { AND: [onTimestamp(sort, from), { OR: [onTimestamp(sort, past), { id: pastId }] }] };
}

/** Like afterTimestamp, for the tasks that have a due date (the first part of a due-date list). */
export function datedAfter(order: SortOrder, value: Date, id: string): Where {
  const asc = order === 'asc';
  const from: Prisma.DateTimeNullableFilter<'Task'> = asc ? { gte: value } : { lte: value };
  const past: Prisma.DateTimeNullableFilter<'Task'> = asc ? { gt: value } : { lt: value };
  const pastId: Prisma.UuidFilter<'Task'> = asc ? { gt: id } : { lt: id };
  return { AND: [{ dueDate: from }, { OR: [{ dueDate: past }, { id: pastId }] }] };
}

/** The tasks without a due date that come after this id (the second part of a due-date list). */
export function undatedAfter(order: SortOrder, id: string): Where {
  return { dueDate: null, id: order === 'asc' ? { gt: id } : { lt: id } };
}

/** The value a cursor records for this task: its sort field, as text. */
function sortValue(task: Task, sort: TaskSort): string | null {
  if (sort === 'dueDate') return task.dueDate === null ? null : isoFromDate(task.dueDate);
  return task[sort].toISOString();
}

/** A cursor names its list: the tasks of one project. */
export const taskListScope = (projectId: string) => `tasks:${projectId}`;

export function taskCursor(task: Task, sort: TaskSort, order: SortOrder): string {
  const scope = taskListScope(task.projectId);
  return encodeCursor({ scope, sort, order, value: sortValue(task, sort), id: task.id });
}
