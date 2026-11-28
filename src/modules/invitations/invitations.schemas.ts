import { z } from 'zod';
import { Id } from '../../lib/ids.js';
import { Text } from '../../lib/text.js';
import { Email } from '../auth/auth.schemas.js';
import { Role, WorkspaceParams } from '../workspaces/workspaces.schemas.js';

export const InvitationParams = WorkspaceParams.extend({ invitationId: Id });

// OWNER is deliberately not allowed here: ownership is never handed out by
// invitation, only by an existing owner promoting an existing member.
// That's a rule about the *shape* of the input, so it's a 400, not a 403.
export const CreateInvitationBody = z.object({
  email: Email,
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

export const AcceptInvitationBody = z.object({
  token: Text.min(1).max(200),
});

export const Invitation = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: Role.describe('The role the invitee gets when they accept'),
    invitedById: z.uuid().nullable(),
    expiresAt: z.date(),
    createdAt: z.date(),
  })
  .meta({ id: 'Invitation', description: 'An invitation that is still pending' });

/** The token is returned exactly once, at creation, like an API key. */
export const CreatedInvitation = z
  .object({
    invitation: Invitation,
    token: z.string().describe('Shown only this once: send it to the invitee'),
  })
  .meta({ id: 'CreatedInvitation' });

export const InvitationList = z
  .object({ data: z.array(Invitation) })
  .meta({ id: 'InvitationList' });
