// @ts-check
/**
 * tools/lint-meta — frontend layer-boundary enforcement for apps/web.
 *
 * Feature isolation (a component in one feature must not import another) is now
 * owned by `@nightcore/eslint-plugin`'s `no-cross-feature-imports` rule, wired
 * scoped to `apps/web/src/components/**` in the root `eslint.config.mjs`. What
 * remains here are the two boundaries that rule does not express, encoded with
 * ESLint's built-in `no-restricted-imports`:
 *
 *   1. Only `lib/bridge.ts` may import `@tauri-apps/api`. It is the single Tauri
 *      seam; every other module talks to the core through it.
 *   2. `components/ui` (the shadcn-style primitives dir, the cross-feature escape
 *      hatch) must not import from a feature. Primitives are leaves of the
 *      dependency graph — features depend on ui, never the reverse.
 *
 * Pure ESLint built-ins, no plugin dependency.
 *
 * Flat-config note: `no-restricted-imports` does NOT merge across blocks — for
 * a given file the last matching block's rule config wins. So each block below
 * carries the FULL set of bans that apply to its files (e.g. the ui-purity block
 * repeats the Tauri-seam ban), rather than relying on a broad block to also
 * cover those files.
 */

const WEB = 'apps/web/src';

const TAURI_GROUP = [
  '@tauri-apps/api',
  '@tauri-apps/api/*',
  '@tauri-apps/plugin-*',
];
const TAURI_MESSAGE =
  'Only lib/bridge.ts may import @tauri-apps/* (api + plugins). Route Tauri commands/events through the bridge seam.';

/**
 * The SDK ban from the base config. Repeated here because `no-restricted-imports`
 * does not merge: these per-file web blocks override the broad `apps/**` block,
 * so the SDK ban must travel with them to stay in force inside apps/web.
 */
const SDK_PATH = {
  name: '@anthropic-ai/claude-agent-sdk',
  message:
    'Surfaces must not import the Claude Agent SDK directly. Go through @nightcore/engine.',
};

/** Patterns matching any feature folder under components/, in alias + relative form. */
const FEATURE_GROUPS = [
  '**/components/board',
  '**/components/board/**',
  '**/components/projects',
  '**/components/projects/**',
  '**/components/settings',
  '**/components/settings/**',
  '**/components/new-project',
  '**/components/new-project/**',
  '@/components/board',
  '@/components/board/**',
  '@/components/projects',
  '@/components/projects/**',
  '@/components/settings',
  '@/components/settings/**',
  '@/components/new-project',
  '@/components/new-project/**',
];

/** Block 1 — every web file except lib/bridge.ts: forbid the Tauri API. */
const tauriSeamBlock = {
  files: [`${WEB}/**/*.{ts,tsx}`],
  ignores: [`${WEB}/lib/bridge.ts`, `${WEB}/components/ui/**`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [SDK_PATH],
        patterns: [{ group: TAURI_GROUP, message: TAURI_MESSAGE }],
      },
    ],
  },
};

/** Block 2 — components/ui/**: forbid importing features and the Tauri API. */
const uiPurityBlock = {
  files: [`${WEB}/components/ui/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [SDK_PATH],
        patterns: [
          {
            group: FEATURE_GROUPS,
            message:
              'components/ui must not import from a feature. Primitives are leaves — features depend on ui, never the reverse.',
          },
          { group: TAURI_GROUP, message: TAURI_MESSAGE },
        ],
      },
    ],
  },
};

/**
 * The flat-config blocks enforcing the frontend layer boundaries.
 * Spread into the root eslint.config.mjs.
 * @type {import('eslint').Linter.Config[]}
 */
export const layerRules = [tauriSeamBlock, uiPurityBlock];

export default layerRules;
