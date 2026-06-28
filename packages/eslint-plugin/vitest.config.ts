/** Vitest config for @nightcore/eslint-plugin: run the rule tests under tests/ in a node environment. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
