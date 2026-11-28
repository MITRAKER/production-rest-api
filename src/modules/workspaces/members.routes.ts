import type { FastifySchema } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/responses.js';
import { MemberService } from './members.service.js';
import {
  ChangeRoleBody,
  Member,
  MemberList,
  MemberParams,
  WorkspaceParams,
} from './workspaces.schemas.js';

const tags = ['members'];

/** What each route accepts and answers: checked on every request, and published at /docs. */
const schemas = {
  list: {
    tags,
    operationId: 'listMembers',
    summary: 'List the members of a workspace',
    description: 'For its members.',
    params: WorkspaceParams,
    response: { 200: MemberList.describe('The members'), ...errorResponses(400, 401, 404) },
  },
  changeRole: {
    tags,
    operationId: 'changeMemberRole',
    summary: "Change a member's role",
    description:
      'For owners, on admins and members, or on themselves to step down. A workspace always ' +
      'keeps at least one owner (LAST_OWNER).',
    params: MemberParams,
    body: ChangeRoleBody,
    response: {
      200: Member.describe('The member, with their new role'),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  remove: {
    tags,
    operationId: 'removeMember',
    summary: 'Remove a member, or leave',
    description:
      'Anyone can leave (remove themselves), except the last owner (LAST_OWNER). Owners and ' +
      'admins can remove people whose role is lower than theirs. Their tasks become unassigned.',
    params: MemberParams,
    response: {
      204: z.null().describe('Removed'),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
} satisfies Record<string, FastifySchema>;

/** Members, nested under their workspace: /workspaces/:workspaceId/members/... */
const membersRoutes: FastifyPluginCallbackZod<{ maxMembersPerWorkspace: number }> = (
  app,
  opts,
  done,
) => {
  const members = new MemberService(app, opts);

  app.addHook('onRequest', app.authenticate);

  app.get('/:workspaceId/members', { schema: schemas.list }, async (request) => ({
    data: await members.list(request.params.workspaceId, request.user.sub),
  }));

  app.patch('/:workspaceId/members/:userId', { schema: schemas.changeRole }, async (request) =>
    members.changeRole(
      request.params.workspaceId,
      request.user.sub,
      request.params.userId,
      request.body.role,
    ),
  );

  app.delete(
    '/:workspaceId/members/:userId',
    { schema: schemas.remove },
    async (request, reply) => {
      await members.remove(request.params.workspaceId, request.user.sub, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  done();
};

export default membersRoutes;
