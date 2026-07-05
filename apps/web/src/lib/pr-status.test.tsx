/** Unit tests for the pure gh-vocabulary mappers — specifically the
 *  merge-readiness badge's severity ordering (conflicts > failing checks >
 *  changes requested > draft > running checks > review required > ready). */
import { expect, test } from 'vitest';

import type { PrStatus } from '@/lib/bridge';
import { mergeReadiness } from '@/lib/pr-status';

/** A clean, open, mergeable PR — every test overrides from "ready". */
function status(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checksPassed: 4,
    checksFailed: 0,
    checksPending: 0,
    baseRefName: 'main',
    headRefOid: 'abc',
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    unpushedCommits: null,
    ...over,
  };
}

test('a clean open PR reads Ready to merge', () => {
  expect(mergeReadiness(status())?.label).toBe('Ready to merge');
});

test('non-open PRs render no readiness badge (the state badge already says it)', () => {
  expect(mergeReadiness(status({ state: 'MERGED' }))).toBeNull();
  expect(mergeReadiness(status({ state: 'CLOSED' }))).toBeNull();
});

test('an uncomputed mergeability never guesses', () => {
  expect(mergeReadiness(status({ mergeable: 'UNKNOWN' }))).toBeNull();
});

test('severity ordering: conflicts beat failing checks beat changes requested', () => {
  const everything = status({
    mergeable: 'CONFLICTING',
    checksFailed: 2,
    reviewDecision: 'CHANGES_REQUESTED',
  });
  expect(mergeReadiness(everything)?.label).toBe('Conflicts — needs resolution');
  expect(
    mergeReadiness(status({ checksFailed: 2, reviewDecision: 'CHANGES_REQUESTED' }))
      ?.label,
  ).toBe('Needs fixing — checks failing');
  expect(mergeReadiness(status({ reviewDecision: 'CHANGES_REQUESTED' }))?.label).toBe(
    'Needs fixing — changes requested',
  );
});

test('draft, running checks, and review-required read as their own states', () => {
  expect(mergeReadiness(status({ isDraft: true }))?.label).toBe('Draft — not ready');
  expect(mergeReadiness(status({ checksPending: 1 }))?.label).toBe('Checks running');
  expect(mergeReadiness(status({ reviewDecision: 'REVIEW_REQUIRED' }))?.label).toBe(
    'Needs review',
  );
});

test('an approved PR with green checks is Ready to merge', () => {
  expect(mergeReadiness(status({ reviewDecision: 'APPROVED' }))?.label).toBe(
    'Ready to merge',
  );
});
