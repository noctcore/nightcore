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
    // Coverage is OFF by default (bare `vitest run` / the per-project
    // `test:unit` / `test:stories` scripts stay fast and don't trip thresholds
    // on a partial run). It activates only under `--coverage` (the `test:coverage`
    // script CI runs via `test:web:coverage`), which runs BOTH projects so the
    // aggregate reflects the whole suite — the web-tier analogue of the node
    // tier's tools/coverage/check-node-coverage.ts floor. The floors start a
    // comfortable margin below today's actual (~69% line / ~61% fn) as a ratchet
    // against a new component/route shipping untested; tighten over time.
    coverage: {
      provider: 'istanbul',
      include: ['src/**'],
      exclude: [
        'src/lib/generated/**',
        '**/*.stories.tsx',
        '**/*.test.tsx',
        '**/*.test.ts',
      ],
      reporter: ['text-summary'],
      thresholds: {
        statements: 55,
        branches: 55,
        functions: 50,
        lines: 60,
      },
    },
    projects: [
      {
        plugins: [
          storybookTest({
            configDir: fileURLToPath(new URL('./.storybook', import.meta.url)),
          }),
        ],
        resolve: { alias },
        // Pre-bundle react-dom/client for the storybook project too, to avoid
        // mid-run re-optimize (which causes "Failed to fetch dynamically imported module"
        // flakes when other tests are loading).
        optimizeDeps: {
          include: [
            'react-dom/client',
            'motion/react',
            'lucide-react',
            '@xterm/xterm',
            '@xterm/addon-fit',
          ],
        },
        test: {
          name: 'storybook',
          setupFiles: ['./.storybook/vitest.setup.ts'],
          browser: chromium(),
          // Retry transient browser load flakes (e.g. "Failed to fetch dynamically imported module"
          // during re-optimize or port contention in CI).
          retry: 1,
        },
      },
      {
        plugins: [react(), tailwind()],
        resolve: { alias },
        // Force `react-dom/client` into Vite's FIRST dependency-optimize pass.
        // `vitest-browser-react`'s `render()` imports `react-dom/client`
        // (`createRoot`), but @vitejs/plugin-react's auto-include only covers
        // `react` / `react-dom` / the jsx runtimes — NOT the `/client` subpath. So
        // the initial scan misses it and the first test that actually renders
        // discovers it mid-run, which makes Vite log "optimized dependencies
        // changed. reloading" and reload the page WHILE other test modules are
        // still loading. Those in-flight `?v=<hash>` module URLs then 404 with
        // "Failed to fetch dynamically imported module" — a nondeterministic
        // whole-suite flake (a different `.test.tsx` file fails each CI run).
        // Pre-bundling it here means no second optimize pass, so no mid-run reload.
        optimizeDeps: {
          include: [
            'react-dom/client',
            'motion/react',
            'lucide-react',
            '@xterm/xterm',
            '@xterm/addon-fit',
          ],
        },
        test: {
          name: 'unit',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./.storybook/vitest.setup.ts'],
          // Retry transient browser load flakes (e.g. "Failed to fetch dynamically imported module"
          // during re-optimize or port contention in CI).
          retry: 1,
          browser: chromium(),
        },
      },
    ],
  },
});
