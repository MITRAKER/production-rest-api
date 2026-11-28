import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
import { ProjectParams } from '../projects/projects.schemas.js';
import {
  CreateTaskBody,
  Task,
  TaskListQuery,
  TaskPage,
  TaskParams,
  UpdateTaskBody,
} from './tasks.schemas.js';
import { TaskService } from './tasks.service.js';

const tags = ['tasks'];

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  create: {
    tags,
    operationId: 'createTask',
    summary: 'Create a task',
    description:
      'For members of the workspace. A task can only be assigned to a member ' +
      '(ASSIGNEE_NOT_MEMBER). LIMIT_REACHED once the project has too many tasks.',
    params: ProjectParams,
    body: CreateTaskBody,
    response: { 201: Task.describe('The new task'), ...errorResponses(400, 401, 404, 409) },
  },
  list: {
    tags,
    operationId: 'listTasks',
    summary: 'List the tasks of a project',
    description:
      'For members of the workspace. Filter by status, priority, assignee, due date or a word ' +
      'in the title, and sort by createdAt, updatedAt or dueDate. One page at a time: send ' +
      'nextCursor back as cursor, with the same sort and order, for the next page.',
    params: ProjectParams,
    querystring: TaskListQuery,
    response: { 200: TaskPage.describe('One page of tasks'), ...errorResponses(400, 401, 404) },
  },
  get: {
    tags,
    operationId: 'getTask',
    summary: 'Get a task',
    description: 'For members of the workspace.',
    params: TaskParams,
    response: { 200: Task.describe('The task'), ...errorResponses(400, 401, 404) },
  },
  update: {
    tags,
    operationId: 'updateTask',
    summary: 'Change a task',
    description:
      'For members of the workspace. Send only the fields to change: null clears dueDate or ' +
      'assigneeId, and a field left out keeps its value.',
    params: TaskParams,
    body: UpdateTaskBody,
    response: { 200: Task.describe('The changed task'), ...errorResponses(400, 401, 404) },
  },
  delete: {
    tags,
    operationId: 'deleteTask',
    summary: 'Delete a task',
    description: 'For the member who created it, and for owners and admins.',
    params: TaskParams,
    response: { 204: z.null().describe('Deleted'), ...errorResponses(400, 401, 403, 404) },
  },
} satisfies Record<string, FastifySchema>;

const TASKS = '/:workspaceId/projects/:projectId/tasks';
const TASK = `${TASKS}/:taskId`;

/** Tasks, nested under their project: /workspaces/:workspaceId/projects/:projectId/tasks/... */
const tasksRoutes: FastifyPluginCallbackZod<{ maxTasksPerProject: number }> = (app, opts, done) => {
  const tasks = new TaskService(app, opts);

  app.addHook('onRequest', app.authenticate);

  app.post(TASKS, { schema: schemas.create }, async (request, reply) => {
    const task = await tasks.create(request.params, request.user.sub, request.body);
    return reply.code(201).send(task);
  });

  app.get(TASKS, { schema: schemas.list }, async (request) =>
    tasks.list(request.params, request.user.sub, request.query),
  );

  app.get(TASK, { schema: schemas.get }, async (request) =>
    tasks.get(request.params, request.user.sub),
  );

  app.patch(TASK, { schema: schemas.update }, async (request) =>
    tasks.update(request.params, request.user.sub, request.body),
  );

  app.delete(TASK, { schema: schemas.delete }, async (request, reply) => {
    await tasks.delete(request.params, request.user.sub);
    return reply.code(204).send(null);
  });

  done();
};

export default tasksRoutes;
