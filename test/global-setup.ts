import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadTestEnv } from './test-env.js';

// Run the Prisma CLI with the current Node binary and an explicit path,
// rather than looking up "npx" on the PATH (which could be hijacked).
const prismaCli = join(import.meta.dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');

/**
 * Runs once before all tests: applies every migration to the test database,
 * so tests always run against the real, current schema.
 */
export default function setup() {
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, ...loadTestEnv() },
  });
}
