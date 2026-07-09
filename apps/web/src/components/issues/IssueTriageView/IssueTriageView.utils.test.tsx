import { expect, test } from 'vitest';

import type { IssueSummary } from '@/lib/bridge';

import { errMessage, matchesFilter } from './IssueTriageView.utils';

function issue(overrides: Partial<IssueSummary>): IssueSummary {
  return {
    number: 1,
    title: '',
    state: 'open',
    labels: [],
    author: '',
    createdAt: '',
    updatedAt: '',
    commentCount: 0,
    linkedPrs: [],
    ...overrides,
  };
}

test('errMessage unwraps an Error to its message', () => {
  expect(errMessage(new Error('boom'))).toBe('boom');
});

test('errMessage stringifies non-Error throwables', () => {
  expect(errMessage('nope')).toBe('nope');
  expect(errMessage(42)).toBe('42');
  expect(errMessage(null)).toBe('null');
});

test('matchesFilter matches everything on an empty (or whitespace) query', () => {
  const i = issue({ title: 'anything' });
  expect(matchesFilter(i, '')).toBe(true);
  expect(matchesFilter(i, '   ')).toBe(true);
});

test('matchesFilter matches on the issue number with a leading #', () => {
  const i = issue({ number: 42 });
  expect(matchesFilter(i, '#42')).toBe(true);
  expect(matchesFilter(i, '4')).toBe(true);
  expect(matchesFilter(i, '#99')).toBe(false);
});

test('matchesFilter matches title, author, and labels case-insensitively', () => {
  const i = issue({ title: 'Broken Login', author: 'Octocat', labels: ['Bug', 'P1'] });
  expect(matchesFilter(i, 'login')).toBe(true);
  expect(matchesFilter(i, 'OCTO')).toBe(true);
  expect(matchesFilter(i, 'bug')).toBe(true);
  expect(matchesFilter(i, 'nomatch')).toBe(false);
});
