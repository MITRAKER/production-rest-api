import { config } from 'dotenv';

/**
 * Environment for the test run: .env.test, plus one optional override.
 * TEST_DATABASE_URL lets you (or CI, or two parallel runs) point the tests
 * at a different database without editing any file.
 */
export function loadTestEnv(): Record<string, string> {
  const env = config({ path: '.env.test', quiet: true }).parsed ?? {};
  const override = process.env['TEST_DATABASE_URL'];
  return override === undefined ? env : { ...env, DATABASE_URL: override };
}
