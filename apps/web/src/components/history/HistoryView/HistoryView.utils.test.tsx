import { expect, test } from 'vitest';

import type { ScanRunSummary } from './HistoryView.types';
import { familyCounts, narrowedLabel, retentionNotice } from './HistoryView.utils';

function run(family: ScanRunSummary['family'], id: string): ScanRunSummary {
  return {
    id,
    family,
    title: '1 finding',
    status: 'completed',
    createdAt: 0,
    projectPath: '/repo',
    model: '',
    costUsd: 0,
    durationMs: 0,
  };
}

test('familyCounts counts every family, zero included', () => {
  const counts = familyCounts([run('insight', 'a'), run('insight', 'b'), run('harness', 'c')]);
  expect(counts).toEqual({ insight: 2, harness: 1, scorecard: 0 });
});

test('familyCounts of an empty history is all zeroes', () => {
  expect(familyCounts([])).toEqual({ insight: 0, scorecard: 0, harness: 0 });
});

test('retentionNotice names the cap when it is known', () => {
  // The number comes from the enforcing Rust constant via AppInfo, so the copy must
  // interpolate it rather than hardcode 50.
  expect(retentionNotice(50)).toContain('50 most recent runs per kind');
  expect(retentionNotice(12)).toContain('12 most recent runs per kind');
});

test('retentionNotice states the rule without inventing a number when unprobed', () => {
  const text = retentionNotice(null);
  expect(text).toContain('bounded number of runs per kind');
  expect(text).not.toMatch(/\d/);
  expect(retentionNotice(undefined)).toBe(text);
});

test('narrowedLabel appears only while a filter hides something', () => {
  expect(narrowedLabel(3, 12)).toBe('Showing 3 of 12');
  expect(narrowedLabel(12, 12)).toBeNull();
  expect(narrowedLabel(0, 0)).toBeNull();
});
