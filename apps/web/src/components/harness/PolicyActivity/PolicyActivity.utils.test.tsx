import { expect, test } from 'vitest';

import type { PolicyActivityEntry } from '@/lib/bridge';

import {
  isProjectRule,
  projectRuleCount,
  relativeAge,
  ruleLabel,
} from './PolicyActivity.utils';

/** A minimal entry with the given overrides. */
function entry(overrides: Partial<PolicyActivityEntry> = {}): PolicyActivityEntry {
  return {
    id: 'task-1:0',
    taskId: 'task-1',
    taskTitle: 'A task',
    ts: '2026-07-29T10:00:00.000Z',
    tool: 'Write',
    inputDigest: 'bun.lock',
    decision: 'deny',
    ruleId: 'harness-protected-path',
    source: 'policy',
    ...overrides,
  };
}

test('every harness policy tier has a plain-language label', () => {
  for (const rule of [
    'harness-protected-path',
    'harness-read-deny',
    'harness-bash-deny',
    'harness-tool-deny',
    'harness-tool-ask',
  ]) {
    expect(ruleLabel(rule)).not.toBe(rule);
  }
});

test('an unknown rule id renders as itself rather than being swallowed', () => {
  expect(ruleLabel('some-future-rail')).toBe('some-future-rail');
});

test('built-in rails are labelled too, and marked as not the project’s own', () => {
  expect(ruleLabel('pipe-to-shell')).toBe('Piping a download into a shell');
  expect(isProjectRule(entry({ source: 'builtin', ruleId: 'pipe-to-shell' }))).toBe(false);
  expect(isProjectRule(entry())).toBe(true);
});

test('relativeAge scales from seconds to days', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');
  expect(relativeAge('2026-07-29T11:59:30.000Z', now)).toBe('just now');
  expect(relativeAge('2026-07-29T11:56:00.000Z', now)).toBe('4m ago');
  expect(relativeAge('2026-07-29T09:00:00.000Z', now)).toBe('3h ago');
  expect(relativeAge('2026-07-27T12:00:00.000Z', now)).toBe('2d ago');
});

test('relativeAge degrades to null for a missing or unparseable timestamp', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');
  expect(relativeAge(null, now)).toBeNull();
  expect(relativeAge('not a date', now)).toBeNull();
});

test('a future timestamp never renders as a negative age', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');
  expect(relativeAge('2026-07-29T12:05:00.000Z', now)).toBe('just now');
});

test('projectRuleCount counts only the author-editable rules', () => {
  expect(
    projectRuleCount([entry(), entry({ source: 'builtin' }), entry({ id: 'x' })]),
  ).toBe(2);
});
