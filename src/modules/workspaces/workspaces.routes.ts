import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceService } from './workspaces.service.js';
import {
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  WorkspaceList,
  WorkspaceParams,
  WorkspaceSummary,
} from './workspaces.schemas.js';

const workspacesRoutes: FastifyPluginCallbackZod<{ maxWorkspacesPerUser: number }> = (
  app,
  opts,
  done,
) => {
  const workspaces = new WorkspaceService(app, opts);

  // Every route in this plugin requires a logged-in user.
  app.addHook('preHandler', app.authenticate);

  app.post(
    '/',
    { schema: { body: CreateWorkspaceBody, response: { 201: WorkspaceSummary } } },
    async (request, reply) => {
      const workspace = await workspaces.create(request.user.sub, request.body.name);
      return reply.code(201).send(workspace);
    },
  );

  app.get('/', { schema: { response: { 200: WorkspaceList } } }, async (request) => ({
    data: await workspaces.listForUser(request.user.sub),
  }));

  app.get(
    '/:workspaceId',
    { schema: { params: WorkspaceParams, response: { 200: WorkspaceSummary } } },
    async (request) => workspaces.get(request.params.workspaceId, request.user.sub),
  );

  app.patch(
    '/:workspaceId',
    {
      schema: {
        params: WorkspaceParams,
        body: UpdateWorkspaceBody,
        response: { 200: WorkspaceSummary },
      },
    },
    async (request) =>
      workspaces.update(request.params.workspaceId, request.user.sub, request.body),
  );

  app.delete(
    '/:workspaceId',
    { schema: { params: WorkspaceParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await workspaces.delete(request.params.workspaceId, request.user.sub);
      return reply.code(204).send(null);
    },
  );

  done();
};

export default workspacesRoutes;
