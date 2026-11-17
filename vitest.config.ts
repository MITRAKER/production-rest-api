import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

export default defineConfig({
  test: {
    // Tests use their own database so they never touch your dev data.
    env: config({ path: '.env.test', quiet: true }).parsed,
    include: ['test/**/*.test.ts'],
  },
});
