import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { Errors } from '../../lib/errors.js';

/** The ids in a project's URL: /workspaces/:workspaceId/projects/:projectId. */
export interface ProjectRef {
  workspaceId: string;
  projectId: string;
}

/**
 * Returns the project, looked up by its id AND its workspace's id.
 *
 * The workspace id comes from the URL and the caller's membership in it was
 * already checked. Looking the project up by both ids means a project id
 * from another workspace simply isn't found (404): knowing an id is never
 * enough to reach someone else's data (IDOR, LEARNING.md chapter 4).
 */
export async function requireProject(db: Db, ref: ProjectRef) {
  const project = await db.project.findUnique({
    where: { id_workspaceId: { id: ref.projectId, workspaceId: ref.workspaceId } },
  });
  if (project === null) throw Errors.notFound('Project');
  return project;
}

/**
 * Locks the project row until the surrounding transaction ends (scoped by
 * workspace too, so it's also the existence check: 404 if there's no such
 * project in this workspace).
 *
 * Creating a task takes it, so two creations in the same project run one
 * after the other and the task quota's count stays true. Renaming and
 * deleting take it too, so they can't interleave with each other or with a
 * task being created. Lock order: the workspace first, then the project.
 */
export async function lockProject(tx: Prisma.TransactionClient, ref: ProjectRef) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM projects
    WHERE id = ${ref.projectId}::uuid AND workspace_id = ${ref.workspaceId}::uuid
    FOR UPDATE`;
  if (rows.length === 0) throw Errors.notFound('Project');
}
