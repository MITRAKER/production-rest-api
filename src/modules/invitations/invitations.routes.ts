import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
import { WorkspaceParams, WorkspaceSummary } from '../workspaces/workspaces.schemas.js';
import { InvitationService, type InvitationOptions } from './invitations.service.js';
import {
  AcceptInvitationBody,
  CreatedInvitation,
  CreateInvitationBody,
  InvitationList,
  InvitationParams,
} from './invitations.schemas.js';

const tags = ['invitations'];

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  create: {
    tags,
    operationId: 'createInvitation',
    summary: 'Invite someone by email',
    description:
      'For owners and admins; admins can only invite members. The answer has the ' +
      "invitation's token, this once: send it to the invitee. It expires after a few days.",
    params: WorkspaceParams,
    body: CreateInvitationBody,
    response: {
      201: CreatedInvitation.describe('The invitation, and its token'),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  list: {
    tags,
    operationId: 'listInvitations',
    summary: 'List pending invitations',
    description: 'For owners and admins.',
    params: WorkspaceParams,
    response: {
      200: InvitationList.describe('The pending invitations'),
      ...errorResponses(400, 401, 403, 404),
    },
  },
  revoke: {
    tags,
    operationId: 'revokeInvitation',
    summary: 'Revoke an invitation',
    description: 'For owners and admins; admins only for invitations as a member.',
    params: InvitationParams,
    response: { 204: z.null().describe('Revoked'), ...errorResponses(400, 401, 403, 404) },
  },
  accept: {
    tags,
    operationId: 'acceptInvitation',
    summary: 'Accept an invitation',
    description:
      'Log in with the email the invitation was sent to, then send its token. You join the ' +
      'workspace with the role the invitation names.',
    body: AcceptInvitationBody,
    response: {
      200: WorkspaceSummary.describe('The workspace you joined'),
      ...errorResponses(400, 401, 403, 404, 409, 410),
    },
  },
} satisfies Record<string, FastifySchema>;

const invitationsRoutes: FastifyPluginCallbackZod<InvitationOptions> = (app, opts, done) => {
  const invitations = new InvitationService(app, opts);

  app.addHook('onRequest', app.authenticate);

  app.post(
    '/workspaces/:workspaceId/invitations',
    { schema: schemas.create },
    async (request, reply) => {
      const created = await invitations.create(
        request.params.workspaceId,
        request.user.sub,
        request.body,
      );
      return reply.code(201).send(created);
    },
  );

  app.get('/workspaces/:workspaceId/invitations', { schema: schemas.list }, async (request) => ({
    data: await invitations.listPending(request.params.workspaceId, request.user.sub),
  }));

  app.delete(
    '/workspaces/:workspaceId/invitations/:invitationId',
    { schema: schemas.revoke },
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
  app.post('/invitations/accept', { schema: schemas.accept }, async (request) =>
    invitations.accept(request.user.sub, request.body.token),
  );

  done();
};

export default invitationsRoutes;
