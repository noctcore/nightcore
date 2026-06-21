import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

/**
 * Runs the Storybook stories (including their play functions) as Vitest tests
 * in a real browser via Playwright. Optional locally — the gating verification
 * is `build-storybook`; this config enables `bun run test:stories` when a
 * browser runner is available.
 */
export default defineConfig({
  plugins: [
    storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'storybook',
    setupFiles: ['./.storybook/vitest.setup.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
