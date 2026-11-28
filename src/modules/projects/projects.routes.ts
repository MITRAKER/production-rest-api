import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
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

const tags = ['projects'];

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  create: {
    tags,
    operationId: 'createProject',
    summary: 'Create a project',
    description: 'For owners and admins. LIMIT_REACHED once the workspace has too many projects.',
    params: WorkspaceParams,
    body: CreateProjectBody,
    response: {
      201: Project.describe('The new project'),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  list: {
    tags,
    operationId: 'listProjects',
    summary: 'List the projects of a workspace',
    description:
      'For its members. Oldest first, one page at a time: send nextCursor back as cursor for ' +
      'the next page.',
    params: WorkspaceParams,
    querystring: ProjectListQuery,
    response: {
      200: ProjectPage.describe('One page of projects'),
      ...errorResponses(400, 401, 404),
    },
  },
  get: {
    tags,
    operationId: 'getProject',
    summary: 'Get a project',
    description: 'For members of its workspace.',
    params: ProjectParams,
    response: { 200: Project.describe('The project'), ...errorResponses(400, 401, 404) },
  },
  update: {
    tags,
    operationId: 'updateProject',
    summary: 'Change a project',
    description: 'For owners and admins. Send only the fields to change.',
    params: ProjectParams,
    body: UpdateProjectBody,
    response: {
      200: Project.describe('The changed project'),
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    tags,
    operationId: 'deleteProject',
    summary: 'Delete a project',
    description: 'For owners and admins. Its tasks are deleted with it.',
    params: ProjectParams,
    response: { 204: z.null().describe('Deleted'), ...errorResponses(400, 401, 403, 404) },
  },
} satisfies Record<string, FastifySchema>;

const PROJECTS = '/:workspaceId/projects';
const PROJECT = `${PROJECTS}/:projectId`;

/** Projects, nested under their workspace: /workspaces/:workspaceId/projects/... */
const projectsRoutes: FastifyPluginCallbackZod<{ maxProjectsPerWorkspace: number }> = (
  app,
  opts,
  done,
) => {
  const projects = new ProjectService(app, opts);

  app.addHook('onRequest', app.authenticate);

  app.post(PROJECTS, { schema: schemas.create }, async (request, reply) => {
    const { workspaceId } = request.params;
    const project = await projects.create(workspaceId, request.user.sub, request.body);
    return reply.code(201).send(project);
  });

  app.get(PROJECTS, { schema: schemas.list }, async (request) =>
    projects.list(request.params.workspaceId, request.user.sub, request.query),
  );

  app.get(PROJECT, { schema: schemas.get }, async (request) =>
    projects.get(request.params, request.user.sub),
  );

  app.patch(PROJECT, { schema: schemas.update }, async (request) =>
    projects.update(request.params, request.user.sub, request.body),
  );

  app.delete(PROJECT, { schema: schemas.delete }, async (request, reply) => {
    await projects.delete(request.params, request.user.sub);
    return reply.code(204).send(null);
  });

  done();
};

export default projectsRoutes;
