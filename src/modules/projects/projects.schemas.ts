import { z } from 'zod';
import { pageOf, PageQuery } from '../../lib/pagination.js';
import { Text } from '../../lib/text.js';
import { WorkspaceParams } from '../workspaces/workspaces.schemas.js';

export const ProjectParams = WorkspaceParams.extend({ projectId: z.uuid() });

const Name = Text.trim().min(1).max(100);
const Description = Text.max(2_000);

export const CreateProjectBody = z.object({ name: Name, description: Description.default('') });

// PATCH changes only the fields that are sent, but at least one must be.
export const UpdateProjectBody = z
  .object({ name: Name, description: Description })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' });

export const ProjectListQuery = PageQuery;

export const Project = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  description: z.string(),
  createdById: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ProjectPage = pageOf(Project);

export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;
