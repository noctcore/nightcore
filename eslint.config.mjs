// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nightcore from '@nightcore/eslint-plugin';
import { layerRules } from './tools/lint-meta/index.mjs';

// The folder-per-component convention (Tier C) is enforced on every component
// dir under components/<feature>/. components/ui keeps the lighter shadcn
// convention and is excluded by the rules' own ignorePaths.
const COMPONENTS_GLOB = 'apps/web/src/components/**';
// Composition roots may wire features together: a shell that hosts the board,
// projects, and settings surfaces must import across feature boundaries by
// design. They are exempt from `no-cross-feature-imports` (mirroring shiranami's
// COMPOSITION_ROOT_FEATURES allowlist) while still obeying every other component
// rule (folder structure, thin shells, the single Tauri seam).
const COMPOSITION_ROOT_FEATURES = ['app'];
const COMPOSITION_ROOT_GLOBS = COMPOSITION_ROOT_FEATURES.map(
  (feature) => `apps/web/src/components/${feature}/**`,
);
// Feature-root shared modules (data/util .ts like status.ts, session-stream.ts,
// _fixtures.ts, and the feature barrel index.ts) are not components — the Tier-C
// arch rules target component contracts, not domain models.
const FEATURE_ROOT_FILES = 'apps/web/src/components/*/*.ts';

/**
 * Flat config. The `no-restricted-imports` blocks encode the layer-dependency
 * rules from the architecture doc (§3 table): surfaces and capability packages
 * must never reach for the SDK or the engine directly.
 *
 * The component-architecture rules (folder-per-component, decoupled features,
 * thin component shells) come from @nightcore/eslint-plugin, scoped to
 * components/** below. The remaining frontend layer enforcement (single Tauri
 * seam, components/ui purity) lives in `tools/lint-meta` and is spread in as
 * `layerRules`.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-tsc/**',
      '**/target/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      '**/storybook-static/**',
      '**/*.woff2',
      'design/**',
      // The eslint-plugin's own RuleTester fixtures intentionally omit sibling
      // files (they are inputs to component-folder-structure's failing case).
      'packages/eslint-plugin/tests/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Dogfood probe scripts (scripts/**) are standalone Node/Bun programs, not
    // app code: declare the runtime globals so `no-undef` doesn't flag them on
    // the plain-JS (.mjs) probes. (TS files already get this from tseslint.)
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
  {
    // Surfaces (apps/*) may not import the SDK directly — only the engine façade.
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message:
                'Surfaces must not import the Claude Agent SDK directly. Go through @nightcore/engine.',
            },
          ],
        },
      ],
    },
  },
  {
    // Capability packages (tools/skills/mcp) must never reach up into the engine.
    files: [
      'packages/tools/**/*.ts',
      'packages/skills/**/*.ts',
      'packages/mcp/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nightcore/engine', '@nightcore/engine/*'],
              message:
                'Capability packages must not import the engine (dependency inversion — the engine pulls them in).',
            },
          ],
        },
      ],
    },
  },
  // Component-architecture rules (Tier C), scoped to the component folders.
  // Stories and tests are exercised by Storybook/Vitest, not gated as component
  // shells; feature-root data/util .ts files are domain modules, not components.
  {
    files: [`${COMPONENTS_GLOB}/*.{ts,tsx}`],
    ignores: [`${COMPONENTS_GLOB}/*.{stories,test}.{ts,tsx}`, FEATURE_ROOT_FILES],
    plugins: {
      nightcore,
    },
    rules: {
      'nightcore/component-folder-structure': 'error',
      'nightcore/no-state-in-component-body': 'error',
      // ui = shadcn primitives (the cross-feature escape hatch, skipped dir).
      'nightcore/no-cross-feature-imports': ['error', { sharedFeatures: ['ui'] }],
      'nightcore/max-hooks-per-file': 'error',
    },
  },
  // Composition roots (the app shell) wire features together by design, so the
  // cross-feature import ban is lifted for them. Every other component rule
  // (folder structure, thin shells, hook budget) still applies via the block
  // above; only `no-cross-feature-imports` is relaxed here.
  {
    files: COMPOSITION_ROOT_GLOBS.map((glob) => `${glob}/*.{ts,tsx}`),
    ignores: [`${COMPONENTS_GLOB}/*.{stories,test}.{ts,tsx}`, FEATURE_ROOT_FILES],
    rules: {
      'nightcore/no-cross-feature-imports': 'off',
    },
  },
  // Frontend layer boundaries (single Tauri seam, components/ui purity).
  ...layerRules,
);
