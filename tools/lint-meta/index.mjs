// @ts-check
import { readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/**
 * tools/lint-meta — frontend layer-boundary enforcement for apps/web.
 *
 * Feature isolation (a component in one feature must not import another) is now
 * owned by `@nightcore/eslint-plugin`'s `no-cross-feature-imports` rule, wired
 * scoped to `apps/web/src/components/**` in the root `eslint.config.mjs`. What
 * remains here are the two boundaries that rule does not express, encoded with
 * ESLint's built-in `no-restricted-imports`:
 *
 *   1. Only the `lib/bridge/` seam may import `@tauri-apps/api`. It is the single
 *      Tauri seam (split into types/commands/events/mocks + an index barrel);
 *      every other module talks to the core through it.
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
  'Only lib/bridge/ may import @tauri-apps/* (api + plugins). Route Tauri commands/events through the bridge seam.';

const MOTION_GROUP = ['motion', 'motion/*'];
const MOTION_MESSAGE =
  'lib/** is the framework-neutral data/util leaf BELOW the rendering layer — it must not import motion (a layer inversion, and lib/generated/** is ts-rs codegen). Motion lives in components/ui/motion; features import motion primitives from @/components/ui.';

const COMPONENTS_GROUP = [
  '@/components',
  '@/components/*',
  '@/components/**',
  '**/components/**',
];
const COMPONENTS_MESSAGE =
  'lib/ is the framework-neutral leaf below the rendering layer — it must not import components';

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

/**
 * Feature folders under components/ — derived from the directory tree at
 * config-load time (every directory except `ui`), so new features are covered
 * automatically without touching this file.
 */
const FEATURE_DIRS = readdirSync(
  fileURLToPath(new URL(`../../${WEB}/components`, import.meta.url)),
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory() && entry.name !== 'ui')
  .map((entry) => entry.name)
  .sort();

/** Patterns matching any feature folder under components/, in alias + relative form. */
const FEATURE_GROUPS = FEATURE_DIRS.flatMap((feature) => [
  `**/components/${feature}`,
  `**/components/${feature}/**`,
  `@/components/${feature}`,
  `@/components/${feature}/**`,
]);

/** Block 1 — every web file except the lib/bridge/ seam: forbid the Tauri API. */
const tauriSeamBlock = {
  files: [`${WEB}/**/*.{ts,tsx}`],
  ignores: [`${WEB}/lib/bridge/**`, `${WEB}/components/ui/**`],
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
 * Block 3 — lib/** except the bridge seam: forbid motion (layer inversion). These
 * files are already covered by tauriSeamBlock (SDK + Tauri bans); since
 * `no-restricted-imports` does NOT merge, this later-matching block repeats those
 * bans so they stay in force alongside the new motion ban.
 */
const libMotionBlock = {
  files: [`${WEB}/lib/**/*.{ts,tsx}`],
  ignores: [`${WEB}/lib/bridge/**`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [SDK_PATH],
        patterns: [
          { group: TAURI_GROUP, message: TAURI_MESSAGE },
          { group: MOTION_GROUP, message: MOTION_MESSAGE },
          { group: COMPONENTS_GROUP, message: COMPONENTS_MESSAGE },
        ],
      },
    ],
  },
};

/**
 * Block 4 — lib/bridge/**: the Tauri seam MAY import @tauri-apps/* (so no Tauri
 * ban), but it must not import motion either. Bridge is not matched by
 * tauriSeamBlock (which ignores it), so this is a purely additive motion ban.
 */
const libBridgeMotionBlock = {
  files: [`${WEB}/lib/bridge/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: MOTION_GROUP, message: MOTION_MESSAGE },
          { group: COMPONENTS_GROUP, message: COMPONENTS_MESSAGE },
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
export const layerRules = [
  tauriSeamBlock,
  uiPurityBlock,
  libMotionBlock,
  libBridgeMotionBlock,
];

export default layerRules;
