// @ts-check
import eslint from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
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
 * thin component shells) come from @nightcore/eslint-plugin, scoped below. The
 * remaining frontend layer enforcement (single Tauri seam, components/ui purity)
 * lives in `tools/lint-meta` and is spread in as `layerRules`.
 *
 * The nightcore plugin is registered ONCE, globally, so every scoped block can
 * reference `nightcore/*` rules without re-declaring `plugins` (which would trip
 * flat config's "Cannot redefine plugin" check on overlapping file globs).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-tsc/**',
      '**/target/**',
      '**/node_modules/**',
      // Transient agent worktrees (.claude/worktrees/** and Nightcore's own
      // .nightcore/worktrees/**) contain checkout copies whose nested `scripts/`
      // don't match the top-level `scripts/**` overrides — linting them produces
      // spurious failures against a second copy of the tree. They are never source
      // (both dirs are git-ignored). `.nightcore/` also holds task/session state.
      '**/.claude/**',
      '**/.nightcore/**',
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
  // Register the nightcore plugin once, globally (no rules enabled here).
  {
    plugins: { nightcore },
  },
  // Import ordering is mechanical, not authorial: node/bun builtins →
  // third-party → workspace (@nightcore/*, @/ alias) → relative, blank-line
  // separated (side-effect imports lead). Autofixable via `eslint --fix`.
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            // Side-effect imports (e.g. a CSS entry) stay in their own leading group.
            ['^\\u0000'],
            // Node/Bun builtins.
            ['^node:', '^bun(:|$)'],
            // Third-party packages — everything except the workspace scope.
            ['^(?!@nightcore)@?\\w'],
            // Workspace barrels and the web `@/` alias.
            ['^@nightcore/', '^@/'],
            // Relative imports.
            ['^\\.'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },
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
    // Engine-internal SDK confinement: the SDK *runtime* (query() and the
    // session-store functions) may be imported only in session/sdk-adapter.ts —
    // the one boundary file that translates SDKMessage → NightcoreEvent. Every other
    // engine module may import SDK *types* (`import type`) but never a runtime
    // value, so the SDK's drift-prone runtime API surface stays in one place.
    // The `apps/**` block above keeps surfaces fully SDK-free; this is its
    // intra-engine counterpart (the invariant the layer doc + engine AGENTS.md
    // describe). Uses @typescript-eslint/no-restricted-imports for
    // `allowTypeImports`, which the base ESLint rule lacks. Tests are exempt:
    // they stub the SDK boundary via mock.module() / await import().
    files: ['packages/engine/src/**/*.ts'],
    ignores: [
      'packages/engine/src/session/sdk-adapter.ts',
      'packages/engine/src/**/*.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              allowTypeImports: true,
              message:
                'The SDK runtime API is confined to packages/engine/src/session/sdk-adapter.ts. Other engine modules may import SDK *types* only (`import type`). Route runtime calls through sdk-adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    // Capability packages (skills) must never reach up into the engine.
    files: ['packages/skills/**/*.ts'],
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
  // Barrel-only cross-package imports: a workspace package is consumed through
  // its @nightcore/<pkg> barrel, never a deep subpath into its internals. A
  // custom rule (not no-restricted-imports) so it composes with the SDK/engine
  // bans above rather than overriding them (flat-config no-restricted-imports
  // does not merge across blocks).
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    rules: {
      'nightcore/no-deep-package-imports': 'error',
    },
  },
  // Wire-message naming: a message-schema const whose name ends Event/Command/
  // Query and whose zod object declares `type: z.literal(...)` MUST set that
  // literal to kebab-case(const minus its role suffix). Scoped to the contracts
  // source — the single source of truth for wire shapes. Ships 'off' in
  // recommended; wired ON only here (per the plugin's registration convention).
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'nightcore/wire-message-naming': 'error',
      // Standalone schemas must be `<Pascal>Schema` + inferred sibling type.
      // Discriminated-union members (role suffixes Event/Command/Query) are
      // carved out inside the rule — that carve-out is what un-dormanted it.
      'nightcore/zod-schema-naming': 'error',
    },
  },
  // Component-architecture rules (Tier C), scoped to the component folders.
  // Stories and tests are exercised by Storybook/Vitest, not gated as component
  // shells; feature-root data/util .ts files are domain modules, not components.
  {
    files: [`${COMPONENTS_GLOB}/*.{ts,tsx}`],
    ignores: [`${COMPONENTS_GLOB}/*.{stories,test}.{ts,tsx}`, FEATURE_ROOT_FILES],
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
  // Accessibility gate (a11y). Enforces accessible-name, keyboard-handler, and
  // role/ARIA invariants on the React surface in CI — so a future raw clickable
  // div, an unlabelled control, or a custom interactive missing keyboard support
  // is caught mechanically rather than relying on author discipline + review.
  // Scoped to apps/web JSX only (the sole React surface); the recommended set is
  // the industry-standard baseline and composes with the nightcore plugin above.
  {
    files: ['apps/web/**/*.tsx'],
    ignores: ['apps/web/**/*.{stories,test}.tsx'],
    ...jsxA11y.flatConfigs.recommended,
  },
  // Frontend layer boundaries (single Tauri seam, components/ui purity).
  ...layerRules,
);
