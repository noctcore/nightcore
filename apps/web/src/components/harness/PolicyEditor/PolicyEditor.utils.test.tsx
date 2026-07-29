import { expect, test } from 'vitest';

import type { PolicyDraft } from './PolicyEditor.types';
import {
  blockingIssueCount,
  mergeEntries,
  POLICY_LIST_FIELDS,
  policyEntryIssues,
} from './PolicyEditor.utils';

/** An otherwise-empty draft with the given lists overlaid. */
function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    enabled: true,
    protectedPaths: [],
    denyBashPatterns: [],
    denyReadPaths: [],
    disallowedTools: [],
    askTools: [],
    allowTools: [],
    maxChangedLines: '',
    maxChangedFiles: '',
    ...overrides,
  };
}

test('every list field is diagnosed against a tier', () => {
  expect(POLICY_LIST_FIELDS.map((f) => f.entryKind)).toEqual([
    'path',
    'bash-regex',
    'path',
    'tool',
    'tool',
    'permission-rule',
  ]);
});

test('a blank row is never flagged (save drops it, so it is not a dead rule)', () => {
  const issues = policyEntryIssues(draft({ protectedPaths: ['', '   '] }));
  expect(issues.protectedPaths).toEqual([null, null]);
  expect(blockingIssueCount(issues)).toBe(0);
});

test('valid entries across every tier produce no issues', () => {
  const issues = policyEntryIssues(
    draft({
      protectedPaths: ['migrations/**', 'bun.lock'],
      denyBashPatterns: ['--no-verify'],
      denyReadPaths: ['.env'],
      disallowedTools: ['WebSearch'],
      askTools: ['WebFetch'],
      allowTools: ['Bash(git status:*)'],
    }),
  );
  expect(blockingIssueCount(issues)).toBe(0);
  expect(Object.values(issues).flat().filter(Boolean)).toEqual([]);
});

test('a path entry is diagnosed with the path tier, a bash entry with the regex tier', () => {
  const issues = policyEntryIssues(
    draft({ protectedPaths: ['migrations/{a,b}'], denyBashPatterns: ['**/*.lock'] }),
  );
  expect(issues.protectedPaths[0]?.severity).toBe('error');
  expect(issues.denyBashPatterns[0]?.severity).toBe('error');
  expect(blockingIssueCount(issues)).toBe(2);
});

test('permission-rule syntax in an exact-match tool tier is blocking', () => {
  const issues = policyEntryIssues(draft({ disallowedTools: ['Bash(git push:*)'] }));
  expect(issues.disallowedTools[0]?.severity).toBe('error');
});

test('an ask entry the deny tier already gates warns but never blocks', () => {
  const issues = policyEntryIssues(
    draft({ disallowedTools: ['WebSearch'], askTools: ['WebSearch'] }),
  );
  expect(issues.askTools[0]?.severity).toBe('warning');
  expect(issues.askTools[0]?.message).toContain('deny wins');
  expect(blockingIssueCount(issues)).toBe(0);
});

test('an mcp server glob in the deny tier also shadows a matching ask entry', () => {
  const issues = policyEntryIssues(
    draft({ disallowedTools: ['mcp__acme__*'], askTools: ['mcp__acme__push'] }),
  );
  expect(issues.askTools[0]?.severity).toBe('warning');
});

test('mergeEntries appends new entries, trims, and is idempotent', () => {
  expect(mergeEntries(['bun.lock'], [' migrations/** ', 'bun.lock', ''])).toEqual([
    'bun.lock',
    'migrations/**',
  ]);
  const once = mergeEntries([], ['a', 'b']);
  expect(mergeEntries(once, ['a', 'b'])).toEqual(['a', 'b']);
});
