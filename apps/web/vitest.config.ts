import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

// A FRESH browser config per project. Sharing one object collides: vitest
// mutates each `instances` entry with the owning project's name, so a shared
// reference gets registered twice. Each project derives a unique sub-project
// name ("storybook (chromium)" / "unit (chromium)") from its own object.
const chromium = () => ({
  enabled: true,
  provider: 'playwright' as const,
  headless: true,
  // Emulate `prefers-reduced-motion: reduce` in the test browser. The app's
  // reduced-motion rule collapses every animation to ~0ms (styles.css), so the
  // slide-in detail sheets (`nc-sheet-in`) settle instantly instead of moving
  // ~100px through their 280ms enter — otherwise a `.click()` can race the
  // animation and land off a button that's still sliding, a latent flake in the
  // shared DetailPanelShell click tests (Insight/Scorecard/Harness) that only
  // surfaces in isolated runs. This makes those tests deterministic.
  instances: [
    { browser: 'chromium' as const, context: { reducedMotion: 'reduce' as const } },
  ],
});

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
          browser: chromium(),
        },
      },
      {
        plugins: [react(), tailwind()],
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./.storybook/vitest.setup.ts'],
          browser: chromium(),
        },
      },
    ],
  },
});
