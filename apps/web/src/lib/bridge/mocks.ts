/**
 * Browser-preview / Storybook fallbacks for the web↔Rust bridge. Outside the Tauri
 * webview the command wrappers (`./commands`) degrade to these mocks instead of
 * invoking a live backend, so the board renders with representative data. Kept
 * separate from the command logic so the fallback fixtures are reviewable on their own.
 */
import { KnownModelSchema } from '@nightcore/contracts';

import { staticModelDescriptors } from '../models';
import { PROVIDER_LABEL } from '../provider';
import type {
  AppInfo,
  BoardBackgroundRef,
  HarnessPolicyFile,
  InjectionFlag,
  ModelDescriptor,
  Project,
  ProviderCapabilities,
  ProviderConfigSnapshot,
  Settings,
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
export const MOCK_MODEL_CATALOG: ModelDescriptor[] = staticModelDescriptors();

/** The browser-preview capability descriptor (`get_capabilities` fallback outside
 *  Tauri). Claude's full support matrix — the picker's effort row + the surfaces'
 *  cost lines both stay visible in preview. Also the fail-open default the live
 *  wrapper falls back to when the capabilities read fails. */
export const MOCK_CAPABILITIES: ProviderCapabilities = {
  id: 'claude',
  label: PROVIDER_LABEL,
  autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
  supportsHooks: true,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: true,
  supportsAskUserQuestion: true,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  costTelemetry: 'full',
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
