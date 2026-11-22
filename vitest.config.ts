import { defineConfig } from 'vitest/config';
import { loadTestEnv } from './test/test-env.js';

export default defineConfig({
  test: {
    // Tests use their own database so they never touch your dev data.
    env: loadTestEnv(),
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Generated code, and the entry point that only wires things together
      // and calls listen() (everything it calls is tested through buildApp).
      exclude: ['src/generated/**', 'src/server.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      // CI fails if coverage drops below these numbers.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
