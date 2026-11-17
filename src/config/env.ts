import 'dotenv/config';
import { z } from 'zod';

/**
 * Every setting the app needs, validated once at startup.
 * If something is missing or malformed, the app refuses to start
 * with a clear message, instead of failing later in a random request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // Auth. The secret signs access tokens: anyone who has it can forge logins,
  // so it must be long, random and never committed for production.
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Max login/register attempts per IP per minute (brute-force protection).
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

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
