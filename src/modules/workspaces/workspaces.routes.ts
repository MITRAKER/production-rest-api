import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
import { WorkspaceService } from './workspaces.service.js';
import {
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  WorkspaceList,
  WorkspaceParams,
  WorkspaceSummary,
} from './workspaces.schemas.js';

const tags = ['workspaces'];

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  create: {
    tags,
    operationId: 'createWorkspace',
    summary: 'Create a workspace',
    description: 'You become its owner. LIMIT_REACHED once you belong to too many workspaces.',
    body: CreateWorkspaceBody,
    response: {
      201: WorkspaceSummary.describe('The new workspace'),
      ...errorResponses(400, 401, 409),
    },
  },
  list: {
    tags,
    operationId: 'listWorkspaces',
    summary: 'List your workspaces',
    description: 'Every workspace you are a member of, with your role in each.',
    response: { 200: WorkspaceList.describe('Your workspaces'), ...errorResponses(401) },
  },
  get: {
    tags,
    operationId: 'getWorkspace',
    summary: 'Get a workspace',
    description: 'For its members.',
    params: WorkspaceParams,
    response: {
      200: WorkspaceSummary.describe('The workspace'),
      ...errorResponses(400, 401, 404),
    },
  },
  update: {
    tags,
    operationId: 'renameWorkspace',
    summary: 'Rename a workspace',
    description: 'For its owners and admins.',
    params: WorkspaceParams,
    body: UpdateWorkspaceBody,
    response: {
      200: WorkspaceSummary.describe('The renamed workspace'),
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    tags,
    operationId: 'deleteWorkspace',
    summary: 'Delete a workspace',
    description: 'For its owners. Its projects, tasks and invitations are deleted with it.',
    params: WorkspaceParams,
    response: { 204: z.null().describe('Deleted'), ...errorResponses(400, 401, 403, 404) },
  },
} satisfies Record<string, FastifySchema>;

const workspacesRoutes: FastifyPluginCallbackZod<{ maxWorkspacesPerUser: number }> = (
  app,
  opts,
  done,
) => {
  const workspaces = new WorkspaceService(app, opts);

  // Every route in this plugin requires a logged-in user, checked first.
  app.addHook('onRequest', app.authenticate);

  app.post('/', { schema: schemas.create }, async (request, reply) => {
    const workspace = await workspaces.create(request.user.sub, request.body.name);
    return reply.code(201).send(workspace);
  });

  app.get('/', { schema: schemas.list }, async (request) => ({
    data: await workspaces.listForUser(request.user.sub),
  }));

  app.get('/:workspaceId', { schema: schemas.get }, async (request) =>
    workspaces.get(request.params.workspaceId, request.user.sub),
  );

  app.patch('/:workspaceId', { schema: schemas.update }, async (request) =>
    workspaces.update(request.params.workspaceId, request.user.sub, request.body),
  );

  app.delete('/:workspaceId', { schema: schemas.delete }, async (request, reply) => {
    await workspaces.delete(request.params.workspaceId, request.user.sub);
    return reply.code(204).send(null);
  });

  done();
};

export default workspacesRoutes;
