import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
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

const TASKS = '/:workspaceId/projects/:projectId/tasks';
const TASK = `${TASKS}/:taskId`;

/** Tasks, nested under their project: /workspaces/:workspaceId/projects/:projectId/tasks/... */
const tasksRoutes: FastifyPluginCallbackZod<{ maxTasksPerProject: number }> = (app, opts, done) => {
  const tasks = new TaskService(app, opts);

  app.addHook('preHandler', app.authenticate);

  app.post(
    TASKS,
    { schema: { params: ProjectParams, body: CreateTaskBody, response: { 201: Task } } },
    async (request, reply) => {
      const task = await tasks.create(request.params, request.user.sub, request.body);
      return reply.code(201).send(task);
    },
  );

  app.get(
    TASKS,
    { schema: { params: ProjectParams, querystring: TaskListQuery, response: { 200: TaskPage } } },
    async (request) => tasks.list(request.params, request.user.sub, request.query),
  );

  app.get(TASK, { schema: { params: TaskParams, response: { 200: Task } } }, async (request) =>
    tasks.get(request.params, request.user.sub),
  );

  app.patch(
    TASK,
    { schema: { params: TaskParams, body: UpdateTaskBody, response: { 200: Task } } },
    async (request) => tasks.update(request.params, request.user.sub, request.body),
  );

  app.delete(
    TASK,
    { schema: { params: TaskParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await tasks.delete(request.params, request.user.sub);
      return reply.code(204).send(null);
    },
  );

  done();
};

export default tasksRoutes;
