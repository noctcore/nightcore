import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

const chromium = {
  enabled: true,
  provider: 'playwright' as const,
  headless: true,
  instances: [{ browser: 'chromium' }],
};

/**
 * Two browser projects share one Playwright/chromium runner:
 *
 *  - `storybook` runs every story (and its play function) as a test via the
 *    Storybook plugin. This is the gating play-test suite (`test:stories`).
 *  - `unit` runs the colocated `<Name>.test.tsx` component tests that the
 *    folder-per-component convention (and the `component-folder-structure`
 *    lint rule) requires every component to carry. They reuse the Storybook
 *    preview annotations via `setProjectAnnotations`, so composed stories
 *    render with the cosmic-dark theme decorator.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          storybookTest({
            configDir: fileURLToPath(new URL('./.storybook', import.meta.url)),
          }),
        ],
        resolve: { alias },
        test: {
          name: 'storybook',
          setupFiles: ['./.storybook/vitest.setup.ts'],
          browser: chromium,
        },
      },
      {
        plugins: [react(), tailwind()],
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./.storybook/vitest.setup.ts'],
          browser: chromium,
        },
      },
    ],
  },
});
