import { expect, test } from 'vitest';

import {
  hasProjectScope,
  isProjectOverridable,
  settingScope,
  type SettingsField,
} from './settings-scope';
import { PROJECT_OVERRIDABLE_SETTINGS } from './settings-scope.generated';

test('the run-shaping fields the Rust override carries are per-project', () => {
  // Every one of these is a field of the Rust `SettingsOverride` struct, so the
  // resolver really does merge a project value over the global one.
  for (const field of [
    'defaultModel',
    'defaultEffort',
    'maxConcurrency',
    'permissionMode',
    'defaultRunMode',
    'maxTurns',
    'maxBudgetUsd',
    'mcpServers',
    'contextPackEnabled',
  ] satisfies SettingsField[]) {
    expect(settingScope(field)).toBe('project');
    expect(isProjectOverridable(field)).toBe(true);
  }
});

test('a field the override cannot carry is global for every project', () => {
  // The governance + machine-preference settings: the Rust patch merge IGNORES these
  // for a per-project target, so a "this project only" badge would be a lie.
  for (const field of [
    'provider',
    'cleanupWorktrees',
    'planGateDefault',
    'sandboxSessions',
    'terminalYoloLaunch',
    'autoCommitOnVerified',
    'issueSyncEnabled',
    'usageMeterEnabled',
    'logLevel',
    'sidebarStyle',
    'preferredEditor',
  ] satisfies SettingsField[]) {
    expect(settingScope(field)).toBe('global');
    expect(isProjectOverridable(field)).toBe(false);
  }
});

test('a page has a scope choice only when one of its fields is overridable', () => {
  expect(hasProjectScope(['permissionMode', 'sandboxSessions'])).toBe(true);
  expect(hasProjectScope(['notifyOnComplete', 'terminalBellNotify'])).toBe(false);
  expect(hasProjectScope([])).toBe(false);
});

test('the generated map is the derived source, not a hand-kept copy', () => {
  // A regression canary for the generator itself: if the emitted map ever comes back
  // empty (a parse that silently found nothing), EVERY setting would read "global".
  expect(Object.keys(PROJECT_OVERRIDABLE_SETTINGS).length).toBeGreaterThan(5);
  expect(Object.values(PROJECT_OVERRIDABLE_SETTINGS).every((v) => v)).toBe(true);
});
