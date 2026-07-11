/**
 * Browser-preview / Storybook fallbacks for the web↔Rust bridge. Outside the Tauri
 * webview the command wrappers (`./commands`) degrade to these mocks instead of
 * invoking a live backend, so the board renders with representative data. Kept
 * separate from the command logic so the fallback fixtures are reviewable on their own.
 */
import { KnownModelSchema } from '@nightcore/contracts';

import { codexStaticModelDescriptors, staticModelDescriptors } from '../models';
import { PROVIDER_LABEL } from '../provider';
import { CLAUDE_CAPABILITIES } from '../provider-capabilities';
import type {
  AppInfo,
  BoardBackgroundRef,
  HarnessPolicyFile,
  InjectionFlag,
  ModelDescriptor,
  OnboardingPrerequisites,
  Project,
  ProviderCapabilities,
  ProviderConfigSnapshot,
  Settings,
  TerminalSessionInfo,
} from './types';

/** Canonical fallbacks shared by the browser-preview mocks and UI fallbacks, so
 *  the default model id and repo URL live in exactly one place. The default model
 *  is the first `KnownModel` from the contract (issue #18, item 4) — the same
 *  single source the Rust settings layer and the model picker consume, so the
 *  catalog default is never re-hardcoded per surface. */
// A zod enum always has at least one option, so the first `KnownModel` is present.
const DEFAULT_MODEL_ID = KnownModelSchema.options[0]!;
export const DEFAULT_REPO_URL = 'https://github.com/Shironex/nightcore';

/** A populated mock snapshot so the inspector renders outside Tauri (browser
 *  preview / Storybook). Exercises all three per-section tri-states so the panel's
 *  branches are visible without a live SDK probe. */
export const MOCK_PROVIDER_CONFIG: ProviderConfigSnapshot = {
  providerId: 'claude',
  providerLabel: PROVIDER_LABEL,
  projectPath: '~/dev/nightcore',
  mcp: {
    status: 'supported',
    mcpServers: [
      {
        name: 'github',
        status: 'connected',
        scope: 'project',
        transport: 'http',
        toolCount: 14,
      },
      { name: 'filesystem', status: 'pending', scope: 'user', transport: 'stdio' },
    ],
  },
  skills: {
    status: 'supported',
    skills: [
      { name: 'add-feature', description: 'Plan and ship a new feature' },
      { name: 'fix-bug', description: 'Diagnose an integration that should work' },
    ],
  },
  subagents: {
    status: 'unavailable',
    error: 'probe timed out',
  },
  model: DEFAULT_MODEL_ID,
  // The inspector surfaces Nightcore's neutral autonomy vocabulary (issue #18),
  // the same vocabulary the per-task/settings pickers speak.
  permissionMode: 'auto-accept',
  outputStyle: 'default',
  extrasStatus: 'supported',
};

/** The browser-preview model catalog (`list_models` fallback outside Tauri) — the
 *  curated static descriptors, the same `ModelDescriptor[]` currency the live seam
 *  returns, so the picker renders in Storybook/preview without the engine. */
export const MOCK_MODEL_CATALOG: ModelDescriptor[] = [
  ...staticModelDescriptors(),
  ...codexStaticModelDescriptors(),
];

/** The browser-preview capability descriptor (`get_capabilities` fallback outside
 *  Tauri). Claude's full support matrix — the picker's effort row + the surfaces'
 *  cost lines both stay visible in preview. Also the fail-open default the live
 *  wrapper falls back to when the capabilities read fails. */
export const MOCK_CAPABILITIES: ProviderCapabilities = CLAUDE_CAPABILITIES;

/** A mock project so Storybook/browser preview shows a populated switcher. */
export const MOCK_PROJECT: Project = {
  id: 'mock-nightcore',
  name: 'nightcore',
  path: '~/dev/nightcore',
  branch: 'main',
  createdAt: '2026-06-21T00:00:00Z',
  lastActiveAt: '2026-06-21T00:00:00Z',
  icon: null,
  customIconPath: null,
};

/** Browser-preview onboarding diagnostics: mark local tools ready so the first-run
 *  wizard remains navigable in Storybook/preview without spawning real CLIs. */
export const MOCK_ONBOARDING_PREREQUISITES: OnboardingPrerequisites = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    authenticated: true,
    path: '/usr/local/bin/claude',
    version: 'claude 3.9.2',
    detail: 'authenticated',
    fixHint: 'Install Claude Code, then authenticate it.',
    fixCommand: 'claude auth login',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    installed: true,
    authenticated: true,
    path: '/usr/local/bin/codex',
    version: 'codex 0.42.0',
    detail: 'authenticated',
    fixHint: 'Install Codex CLI, then authenticate it.',
    fixCommand: 'codex login',
  },
  gh: {
    id: 'gh',
    label: 'GitHub CLI',
    installed: true,
    authenticated: true,
    path: '/usr/local/bin/gh',
    version: 'gh version 2.86.0',
    detail: 'Logged in to github.com',
    fixHint: 'Install GitHub CLI, then authenticate it.',
    fixCommand: 'gh auth login',
  },
  git: {
    id: 'git',
    label: 'Git',
    installed: true,
    authenticated: null,
    path: '/usr/bin/git',
    version: 'git version 2.50.0',
    detail: 'git version 2.50.0',
    fixHint: 'Install Git and make sure it is available on PATH.',
    fixCommand: 'git --version',
  },
};

/** The default settings used outside Tauri (browser preview). */
export const MOCK_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL_ID,
  defaultEffort: 'medium',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  provider: 'claude',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  defaultRunMode: 'main',
  maxTurns: null,
  maxBudgetUsd: null,
  mcpServers: [],
  contextPackEnabled: true,
  autoCommitOnVerified: false,
  sandboxSessions: false,
  sidebarStyle: null,
  preferredEditor: null,
  terminalWebglEnabled: false,
  terminalConfinedDefault: false,
  terminalFontSize: null,
  terminalScrollback: null,
  usageMeterEnabled: false,
  terminalYoloLaunch: false,
  projectOverrides: {},
};

/** App metadata used outside Tauri (browser preview). `os` is `'macos'` so the
 *  browser-preview / dogfood surfaces show the macOS-only terminal "Confined"
 *  checkbox (the real value comes from `std::env::consts::OS` inside Tauri). */
export const MOCK_APP_INFO: AppInfo = {
  version: '0.0.0',
  repository: DEFAULT_REPO_URL,
  os: 'macos',
};

/** In-memory background images for browser preview / Storybook (no Tauri fs). Keyed
 *  by project id so the panel + board demo behave like the real per-project store. */
export const MOCK_BACKGROUNDS = new Map<string, { version: number; url: string }>();

/** Build a mock `Settings` whose project override carries (or drops) a background
 *  ref, so the non-Tauri path returns the same shape the real command would. */
export function mockSettingsWithBackground(
  projectId: string,
  ref: BoardBackgroundRef | null,
): Settings {
  const overrides = { ...MOCK_SETTINGS.projectOverrides };
  const prev = overrides[projectId] ?? {};
  overrides[projectId] = { ...prev, boardBackground: ref ?? undefined };
  return { ...MOCK_SETTINGS, projectOverrides: overrides };
}

/** The mock Constitution shown outside Tauri (browser preview). */
export const MOCK_CONTEXT_PACK =
  '# Pre-flight Context Pack\n\nNightcore injects this trusted, project-controlled ' +
  'context into every agent run.\n\n## Project Constitution\n\n- Keep tests green.\n' +
  '- Folder-per-component for every UI component.';

/** The mock policy shown outside Tauri (browser preview / component tests). */
export const MOCK_POLICY_FILE: HarnessPolicyFile = {
  enabled: true,
  protectedPaths: ['bun.lock', 'migrations/**'],
  denyBashPatterns: ['--no-verify'],
  denyReadPaths: ['.env*'],
  disallowedTools: [],
  askTools: ['WebFetch'],
  allowTools: [],
  diffBudget: null,
  manifestExists: true,
};

/** The mock injection-scan flags returned outside Tauri, so the scan card's
 *  results list renders deterministically in Storybook + component tests. */
export const MOCK_INJECTION_FLAGS: InjectionFlag[] = [
  {
    path: 'docs/pasted-snippet.md',
    reasons: ['instruction-shaped phrase: "ignore previous instructions"'],
  },
  {
    path: 'vendor/readme.txt',
    reasons: [
      'invisible Unicode tag characters (hidden-prompt vector)',
      'zero-width character run (hidden-payload vector)',
    ],
  },
];

// --- Echo terminal (browser preview / Storybook / dogfood:ui) -------------
//
// Outside the Tauri webview there is no PTY, so the terminal bridge (`./commands/
// terminal`) drives this in-memory echo instead: spawn prints a banner + prompt,
// each write is echoed back through the same byte handler (CR → CRLF so lines
// feel real), resize is a no-op, kill tears the handler down. This is what lets
// the :5173 mock web render a live-feeling xterm (feasibility §4's echo-bridge
// idiom) and keeps component/hook tests off a real shell.

/** One byte frame from a session's output stream (an xterm-ready chunk). */
export type TerminalByteHandler = (bytes: Uint8Array) => void;

/** The live echo handlers, keyed by the synthetic session id. */
const echoHandlers = new Map<string, TerminalByteHandler>();
let echoSeq = 0;
const echoEncoder = new TextEncoder();
const echoDecoder = new TextDecoder();

/** Spawn an in-memory echo session: registers `onData`, emits a banner + prompt on
 *  the next microtask (so the caller can finish wiring first), and returns the
 *  synthetic descriptor + a detach that stops delivering output. */
export function echoSpawnTerminal(
  opts: { cwd: string; confined: boolean; cols: number; rows: number },
  onData: TerminalByteHandler,
): { session: TerminalSessionInfo; detach: () => void } {
  const id = `echo-${(echoSeq += 1)}`;
  echoHandlers.set(id, onData);
  const session: TerminalSessionInfo = {
    id,
    cwd: opts.cwd,
    shell: '/bin/echo',
    confined: opts.confined,
    cols: opts.cols,
    rows: opts.rows,
    alive: true,
    createdAt: Date.now(),
    title: null,
  };
  queueMicrotask(() => {
    echoHandlers
      .get(id)
      ?.(echoEncoder.encode(`nightcore echo terminal — ${opts.cwd}\r\n$ `));
  });
  return { session, detach: () => echoHandlers.delete(id) };
}

/** Echo written bytes straight back to the session's handler (CR → CRLF). */
export function echoWriteTerminal(id: string, bytes: Uint8Array): void {
  const handler = echoHandlers.get(id);
  if (handler === undefined) return;
  const text = echoDecoder.decode(bytes).replace(/\r/g, '\r\n');
  handler(echoEncoder.encode(text));
}

/** Drop an echo session (mirrors `terminal_kill` outside Tauri). */
export function echoKillTerminal(id: string): void {
  echoHandlers.delete(id);
}

// --- Folder browser (terminal "open a shell in ANY directory") -------------
//
// A small synthetic POSIX filesystem so the FolderBrowserDialog is fully
// navigable in Storybook / component tests / `dogfood:ui` without a real backend.
// The Tauri `list_directory` / `directory_exists` commands replace these inside the
// webview; here we walk a fixed tree rooted at a fake home.

/** The fake home directory the mock browser opens at (matches `list_directory`'s
 *  "no path → home" default). */
export const MOCK_HOME_DIR = '/Users/you';

/** name → optional flags for one mock directory's children. */
interface MockDir {
  name: string;
  isGitRepo?: boolean;
  hidden?: boolean;
}

/** The synthetic tree: absolute dir → its child directories. Unlisted dirs read as
 *  empty (a valid, navigable leaf). */
const MOCK_FS: Record<string, MockDir[]> = {
  '/Users/you': [
    { name: 'projects' },
    { name: 'Documents' },
    { name: 'Downloads' },
    { name: 'Desktop' },
    { name: '.config', hidden: true },
  ],
  '/Users/you/projects': [
    { name: 'nightcore', isGitRepo: true },
    { name: 'automaker', isGitRepo: true },
    { name: 'experiments' },
    { name: 'archive' },
  ],
  '/Users/you/projects/nightcore': [
    { name: 'apps' },
    { name: 'docs' },
    { name: 'tools' },
    { name: '.nightcore', hidden: true },
  ],
  '/Users/you/projects/nightcore/apps': [
    { name: 'web' },
    { name: 'desktop' },
    { name: 'sidecar' },
  ],
  '/Users/you/Documents': [{ name: 'notes' }, { name: 'receipts' }],
};

/** The set of every valid directory path in the mock tree (keys + their children),
 *  so `directory_exists` can answer truthfully offline. */
const MOCK_FS_PATHS: Set<string> = (() => {
  const paths = new Set<string>();
  for (const [dir, children] of Object.entries(MOCK_FS)) {
    paths.add(dir);
    for (const child of children) paths.add(`${dir}/${child.name}`);
  }
  return paths;
})();

/** The parent path of an absolute POSIX dir, or `null` at a top-level root. */
function mockParent(path: string): string | null {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

/** Offline `list_directory`: walk the synthetic tree one level deep. `null` path →
 *  the fake home. Hidden dirs are filtered unless `includeHidden`. */
export function echoListDirectory(
  path: string | null,
  includeHidden: boolean,
): {
  currentPath: string;
  parentPath: string | null;
  entries: { name: string; path: string; isGitRepo: boolean }[];
} {
  const current = path ?? MOCK_HOME_DIR;
  const children = MOCK_FS[current] ?? [];
  const entries = children
    .filter((c) => includeHidden || !c.hidden)
    .map((c) => ({
      name: c.name,
      path: `${current}/${c.name}`,
      isGitRepo: c.isGitRepo ?? false,
    }));
  return { currentPath: current, parentPath: mockParent(current), entries };
}

/** Offline `directory_exists`: true for any path in the synthetic tree. */
export function echoDirectoryExists(path: string): boolean {
  return MOCK_FS_PATHS.has(path);
}
