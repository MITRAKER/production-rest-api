import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceParams, WorkspaceSummary } from '../workspaces/workspaces.schemas.js';
import { InvitationService, type InvitationOptions } from './invitations.service.js';
import {
  AcceptInvitationBody,
  CreatedInvitation,
  CreateInvitationBody,
  InvitationList,
  InvitationParams,
} from './invitations.schemas.js';

const invitationsRoutes: FastifyPluginCallbackZod<InvitationOptions> = (app, opts, done) => {
  const invitations = new InvitationService(app, opts);

  app.addHook('preHandler', app.authenticate);

  app.post(
    '/workspaces/:workspaceId/invitations',
    {
      schema: {
        params: WorkspaceParams,
        body: CreateInvitationBody,
        response: { 201: CreatedInvitation },
      },
    },
    async (request, reply) => {
      const created = await invitations.create(
        request.params.workspaceId,
        request.user.sub,
        request.body,
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/workspaces/:workspaceId/invitations',
    { schema: { params: WorkspaceParams, response: { 200: InvitationList } } },
    async (request) => ({
      data: await invitations.listPending(request.params.workspaceId, request.user.sub),
    }),
  );

  app.delete(
    '/workspaces/:workspaceId/invitations/:invitationId',
    { schema: { params: InvitationParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await invitations.revoke(
        request.params.workspaceId,
        request.user.sub,
        request.params.invitationId,
      );
      return reply.code(204).send(null);
    },
  );

  // The invitee accepts with the token they were given.
  app.post(
    '/invitations/accept',
    { schema: { body: AcceptInvitationBody, response: { 200: WorkspaceSummary } } },
    async (request) => invitations.accept(request.user.sub, request.body.token),
  );

  done();
};

export default invitationsRoutes;
