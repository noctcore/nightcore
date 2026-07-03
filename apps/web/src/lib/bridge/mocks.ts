/**
 * Browser-preview / Storybook fallbacks for the web↔Rust bridge. Outside the Tauri
 * webview the command wrappers (`./commands`) degrade to these mocks instead of
 * invoking a live backend, so the board renders with representative data. Kept
 * separate from the command logic so the fallback fixtures are reviewable on their own.
 */
import type {
  AppInfo,
  BoardBackgroundRef,
  HarnessPolicyFile,
  InjectionFlag,
  Project,
  ProviderConfigSnapshot,
  Settings,
} from './types';

/** Canonical fallbacks shared by the browser-preview mocks and UI fallbacks, so
 *  the default model id and repo URL live in exactly one place. */
const DEFAULT_MODEL_ID = 'claude-opus-4-8';
export const DEFAULT_REPO_URL = 'https://github.com/Shironex/nightcore';

/** A populated mock snapshot so the inspector renders outside Tauri (browser
 *  preview / Storybook). Exercises all three per-section tri-states so the panel's
 *  branches are visible without a live SDK probe. */
export const MOCK_PROVIDER_CONFIG: ProviderConfigSnapshot = {
  providerId: 'claude',
  providerLabel: 'Claude',
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
  permissionMode: 'acceptEdits',
  outputStyle: 'default',
  extrasStatus: 'supported',
};

/** A mock project so Storybook/browser preview shows a populated switcher. */
export const MOCK_PROJECT: Project = {
  id: 'mock-nightcore',
  name: 'nightcore',
  path: '~/dev/nightcore',
  branch: 'main',
  createdAt: '2026-06-21T00:00:00Z',
  lastActiveAt: '2026-06-21T00:00:00Z',
};

/** The default settings used outside Tauri (browser preview). */
export const MOCK_SETTINGS: Settings = {
  defaultModel: DEFAULT_MODEL_ID,
  defaultEffort: 'medium',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  defaultRunMode: 'main',
  maxTurns: null,
  maxBudgetUsd: null,
  mcpServers: [],
  contextPackEnabled: true,
  autoCommitOnVerified: false,
  sandboxSessions: false,
  projectOverrides: {},
};

/** App metadata used outside Tauri (browser preview). */
export const MOCK_APP_INFO: AppInfo = {
  version: '0.0.0',
  repository: DEFAULT_REPO_URL,
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
