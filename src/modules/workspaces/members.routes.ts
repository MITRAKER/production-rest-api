import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MemberService } from './members.service.js';
import {
  ChangeRoleBody,
  Member,
  MemberList,
  MemberParams,
  WorkspaceParams,
} from './workspaces.schemas.js';

/** Members, nested under their workspace: /workspaces/:workspaceId/members/... */
const membersRoutes: FastifyPluginCallbackZod<{ maxMembersPerWorkspace: number }> = (
  app,
  opts,
  done,
) => {
  const members = new MemberService(app, opts);

  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:workspaceId/members',
    { schema: { params: WorkspaceParams, response: { 200: MemberList } } },
    async (request) => ({
      data: await members.list(request.params.workspaceId, request.user.sub),
    }),
  );

  app.patch(
    '/:workspaceId/members/:userId',
    { schema: { params: MemberParams, body: ChangeRoleBody, response: { 200: Member } } },
    async (request) =>
      members.changeRole(
        request.params.workspaceId,
        request.user.sub,
        request.params.userId,
        request.body.role,
      ),
  );

  app.delete(
    '/:workspaceId/members/:userId',
    { schema: { params: MemberParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await members.remove(request.params.workspaceId, request.user.sub, request.params.userId);
      return reply.code(204).send(null);
    },
  );

  done();
};

export default membersRoutes;
