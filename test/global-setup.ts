import { execSync } from 'node:child_process';
import { config } from 'dotenv';

/**
 * Runs once before all tests: applies every migration to the test database,
 * so tests always run against the real, current schema.
 */
export default function setup() {
  const env = config({ path: '.env.test', quiet: true }).parsed ?? {};
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}
