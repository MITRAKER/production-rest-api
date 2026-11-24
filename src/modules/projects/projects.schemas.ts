import { z } from 'zod';
import { Id } from '../../lib/ids.js';
import { pageOf, PageQuery } from '../../lib/pagination.js';
import { Text } from '../../lib/text.js';
import { WorkspaceParams } from '../workspaces/workspaces.schemas.js';

export const ProjectParams = WorkspaceParams.extend({ projectId: Id });

const Name = Text.trim().min(1).max(100);
const Description = Text.max(2_000);

export const CreateProjectBody = z.object({ name: Name, description: Description.default('') });

// PATCH changes only the fields that are sent, but at least one must be.
export const UpdateProjectBody = z
  .object({ name: Name, description: Description })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' });

export const ProjectListQuery = PageQuery;

export const Project = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string(),
    description: z.string(),
    createdById: z.uuid().nullable().describe('Who created it; null if that account is gone'),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Project' });

export const ProjectPage = pageOf(Project).meta({ id: 'ProjectPage' });

export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;
