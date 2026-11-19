import { z } from 'zod';
import { IsoDay } from '../../lib/dates.js';
import { pageOf, PageQuery } from '../../lib/pagination.js';
import { ProjectParams } from '../projects/projects.schemas.js';

export const TaskStatus = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);
export const TaskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const TaskParams = ProjectParams.extend({ taskId: z.uuid() });

const Title = z.string().trim().min(1).max(200);
const Description = z.string().max(5_000);

export const CreateTaskBody = z.object({
  title: Title,
  description: Description.default(''),
  status: TaskStatus.default('TODO'),
  priority: TaskPriority.default('MEDIUM'),
  // Leaving these out (or sending null) means "no due date" and "unassigned".
  dueDate: IsoDay.nullable().default(null),
  assigneeId: z.uuid().nullable().default(null),
});

// PATCH changes only the fields that are sent, but at least one must be.
// Sending null clears the due date or the assignee; leaving a field out
// keeps its value. JSON can tell those two apart, so the API does too.
export const UpdateTaskBody = z
  .object({
    title: Title,
    description: Description,
    status: TaskStatus,
    priority: TaskPriority,
    dueDate: IsoDay.nullable(),
    assigneeId: z.uuid().nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' });

/** "LOW,HIGH" → ["LOW", "HIGH"]. Each item is then checked against the allowed values. */
const CommaList = z
  .string()
  .max(100)
  .transform((value) => value.split(','));

// Sorting and filtering only accept the fields and values listed here (an
// allow-list): a client can't sort or filter by an arbitrary column.
export const TaskSort = z.enum(['createdAt', 'updatedAt', 'dueDate']);

export const TaskListQuery = PageQuery.extend({
  sort: TaskSort.default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  status: CommaList.pipe(z.array(TaskStatus).min(1).max(3)).optional(),
  priority: CommaList.pipe(z.array(TaskPriority).min(1).max(3)).optional(),
  // A member's id, or "none" for the tasks nobody is assigned to.
  assigneeId: z.union([z.uuid(), z.literal('none')]).optional(),
  // Both inclusive: dueFrom=2026-12-01&dueTo=2026-12-31 is all of December.
  dueFrom: IsoDay.optional(),
  dueTo: IsoDay.optional(),
  // Case-insensitive search in task titles.
  q: z.string().trim().min(1).max(100).optional(),
}).refine(
  (query) =>
    query.dueFrom === undefined || query.dueTo === undefined || query.dueFrom <= query.dueTo,
  { message: 'dueFrom must be on or before dueTo', path: ['dueFrom'] },
);

export const Task = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  description: z.string(),
  status: TaskStatus,
  priority: TaskPriority,
  dueDate: z.iso.date().nullable(),
  assigneeId: z.uuid().nullable(),
  createdById: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const TaskPage = pageOf(Task);

export type CreateTaskBody = z.infer<typeof CreateTaskBody>;
export type UpdateTaskBody = z.infer<typeof UpdateTaskBody>;
export type TaskListQuery = z.infer<typeof TaskListQuery>;
export type TaskSort = z.infer<typeof TaskSort>;
