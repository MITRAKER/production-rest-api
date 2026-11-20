import { z } from 'zod';

export const Role = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

// Path parameters are user input too. Validating the uuid format turns a
// malformed id into a clean 400, instead of a database error (500).
export const WorkspaceParams = z.object({ workspaceId: z.uuid() });
export const MemberParams = WorkspaceParams.extend({ userId: z.uuid() });

const Name = z.string().trim().min(1).max(100);

export const CreateWorkspaceBody = z.object({ name: Name });
export const UpdateWorkspaceBody = z.object({ name: Name });
export const ChangeRoleBody = z.object({ role: Role });

/** A workspace as seen by one user: includes *their* role in it. */
export const WorkspaceSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  role: Role,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const Member = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: Role,
  joinedAt: z.date(),
});

// Lists are wrapped in { data: [...] }, so fields can be added next to `data`
// without breaking existing clients. The project and task lists add
// `nextCursor` there; these two are short (bounded by their quotas) and
// still come in one piece.
export const WorkspaceList = z.object({ data: z.array(WorkspaceSummary) });
export const MemberList = z.object({ data: z.array(Member) });
