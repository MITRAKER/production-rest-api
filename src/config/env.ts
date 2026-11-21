import 'dotenv/config';
import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * Every setting the app needs, validated once at startup.
 * If something is missing or malformed, the app refuses to start
 * with a clear message, instead of failing later in a random request.
 */
const TASKS_PER_WORKSPACE = LIMITS.tasksPerWorkspaceMax.toLocaleString('en-US');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Maximum number of open database connections (Power of Ten rule 3).
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    // Auth. The secret signs access tokens: anyone who has it can forge logins,
    // so it must be long, random and never committed for production.
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Max login/register attempts per IP per minute (brute-force protection).
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    // How long an invitation link stays valid (bounded: Power of Ten rule 3).
    INVITATION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),

    // Quotas (Power of Ten rule 3): how much can exist at once (workspaces per
    // user; members, pending invitations and projects per workspace; tasks per
    // project). Each one has its own upper bound, so every list the API returns
    // stays bounded too. Old rows, like revoked or used invitations, still
    // accumulate: LEARNING.md chapter 4 (Rule 3) explains the cleanup this will
    // need.
    MAX_WORKSPACES_PER_USER: z.coerce.number().int().min(1).max(LIMITS.listMax).default(50),
    MAX_MEMBERS_PER_WORKSPACE: z.coerce.number().int().min(1).max(LIMITS.listMax).default(200),
    MAX_PENDING_INVITATIONS: z.coerce.number().int().min(1).max(LIMITS.listMax).default(50),
    // These two multiply: together, at most LIMITS.tasksPerWorkspaceMax tasks
    // per workspace (checked below). Task lists are paginated, so the task
    // quota may go above LIMITS.listMax.
    MAX_PROJECTS_PER_WORKSPACE: z.coerce.number().int().min(1).max(LIMITS.listMax).default(20),
    MAX_TASKS_PER_PROJECT: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.tasksPerWorkspaceMax)
      .default(5_000),
  })
  .refine(
    (env) =>
      env.MAX_PROJECTS_PER_WORKSPACE * env.MAX_TASKS_PER_PROJECT <= LIMITS.tasksPerWorkspaceMax,
    {
      message: `MAX_PROJECTS_PER_WORKSPACE × MAX_TASKS_PER_PROJECT must be at most ${TASKS_PER_WORKSPACE}`,
      path: ['MAX_TASKS_PER_PROJECT'],
    },
  );

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return result.data;
}
