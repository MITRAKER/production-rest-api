import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceParams } from '../workspaces/workspaces.schemas.js';
import {
  CreateProjectBody,
  Project,
  ProjectListQuery,
  ProjectPage,
  ProjectParams,
  UpdateProjectBody,
} from './projects.schemas.js';
import { ProjectService } from './projects.service.js';

/** Projects, nested under their workspace: /workspaces/:workspaceId/projects/... */
const projectsRoutes: FastifyPluginCallbackZod<{ maxProjectsPerWorkspace: number }> = (
  app,
  opts,
  done,
) => {
  const projects = new ProjectService(app, opts);

  app.addHook('preHandler', app.authenticate);

  app.post(
    '/:workspaceId/projects',
    { schema: { params: WorkspaceParams, body: CreateProjectBody, response: { 201: Project } } },
    async (request, reply) => {
      const { workspaceId } = request.params;
      const project = await projects.create(workspaceId, request.user.sub, request.body);
      return reply.code(201).send(project);
    },
  );

  app.get(
    '/:workspaceId/projects',
    {
      schema: {
        params: WorkspaceParams,
        querystring: ProjectListQuery,
        response: { 200: ProjectPage },
      },
    },
    async (request) => projects.list(request.params.workspaceId, request.user.sub, request.query),
  );

  app.get(
    '/:workspaceId/projects/:projectId',
    { schema: { params: ProjectParams, response: { 200: Project } } },
    async (request) => projects.get(request.params, request.user.sub),
  );

  app.patch(
    '/:workspaceId/projects/:projectId',
    { schema: { params: ProjectParams, body: UpdateProjectBody, response: { 200: Project } } },
    async (request) => projects.update(request.params, request.user.sub, request.body),
  );

  app.delete(
    '/:workspaceId/projects/:projectId',
    { schema: { params: ProjectParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await projects.delete(request.params, request.user.sub);
      return reply.code(204).send(null);
    },
  );

  done();
};

export default projectsRoutes;
