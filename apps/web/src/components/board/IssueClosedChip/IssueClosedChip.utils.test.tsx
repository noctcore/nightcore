import { expect, test } from 'vitest';

import { makeTask } from '../_fixtures.task';
import { issueClosedUpstream } from './IssueClosedChip.utils';

test('true only for an issue-linked, still-open task whose issue is closed upstream', () => {
  expect(
    issueClosedUpstream(
      makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'closed' }),
    ),
  ).toBe(true);
});

test('false while the linked issue is still open (or unpolled)', () => {
  expect(
    issueClosedUpstream(makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'open' })),
  ).toBe(false);
  expect(issueClosedUpstream(makeTask({ status: 'in_progress', issueNumber: 128 }))).toBe(false);
});

test('false once the task is Done or merged — a closed issue is then expected', () => {
  expect(
    issueClosedUpstream(makeTask({ status: 'done', issueNumber: 128, issueState: 'closed' })),
  ).toBe(false);
  expect(
    issueClosedUpstream(
      makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'closed', merged: true }),
    ),
  ).toBe(false);
});

test('false when the task links no issue', () => {
  expect(issueClosedUpstream(makeTask({ status: 'in_progress', issueState: 'closed' }))).toBe(
    false,
  );
});
