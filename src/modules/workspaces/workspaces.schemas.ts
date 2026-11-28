import { z } from 'zod';
import { Id } from '../../lib/ids.js';
import { Text } from '../../lib/text.js';

export const Role = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

// Path parameters are user input too: each id is checked and lower-cased (src/lib/ids.ts).
export const WorkspaceParams = z.object({ workspaceId: Id });
export const MemberParams = WorkspaceParams.extend({ userId: Id });

const Name = Text.trim().min(1).max(100);

export const CreateWorkspaceBody = z.object({ name: Name });
export const UpdateWorkspaceBody = z.object({ name: Name });
export const ChangeRoleBody = z.object({ role: Role });

/** A workspace as seen by one user: includes *their* role in it. */
export const WorkspaceSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: Role.describe('Your role in this workspace'),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Workspace', description: 'A workspace, with your role in it' });

export const Member = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: Role,
    joinedAt: z.date(),
  })
  .meta({ id: 'Member', description: 'A member of a workspace, with their role' });

// Lists are wrapped in { data: [...] }, so fields can be added next to `data`
// without breaking existing clients. The project and task lists add
// `nextCursor` there; these two are short (bounded by their quotas) and
// still come in one piece.
export const WorkspaceList = z
  .object({ data: z.array(WorkspaceSummary) })
  .meta({ id: 'WorkspaceList' });
export const MemberList = z.object({ data: z.array(Member) }).meta({ id: 'MemberList' });
