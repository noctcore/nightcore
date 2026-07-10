import { expect, test } from 'vitest';

import {
  defaultSectionForMode,
  type HarnessSectionCounts,
  sectionTabsForMode,
  showProfileBannerForMode,
} from './harness-sections';

const COUNTS: HarnessSectionCounts = {
  conventions: 3,
  proposals: 5,
  artifacts: 2,
};

test('harden shows only the PROPOSE half (Proposals + Artifacts), in order', () => {
  const keys = sectionTabsForMode('harden', COUNTS).map((t) => t.key);
  expect(keys).toEqual(['proposals', 'artifacts']);
});

test('enforce shows only the ENFORCE half (Conventions + Policy), in order', () => {
  const keys = sectionTabsForMode('enforce', COUNTS).map((t) => t.key);
  expect(keys).toEqual(['conventions', 'policy']);
});

test('the unified route (undefined mode) shows every section', () => {
  const keys = sectionTabsForMode(undefined, COUNTS).map((t) => t.key);
  expect(keys).toEqual(['conventions', 'proposals', 'artifacts', 'policy']);
});

test('each tab carries its live badge count; policy is always 0', () => {
  const tabs = sectionTabsForMode(undefined, COUNTS);
  const byKey = Object.fromEntries(tabs.map((t) => [t.key, t.count]));
  expect(byKey).toEqual({ conventions: 3, proposals: 5, artifacts: 2, policy: 0 });
});

test('tabs are labelled for display', () => {
  const [proposals] = sectionTabsForMode('harden', COUNTS);
  expect(proposals).toEqual({ key: 'proposals', label: 'Proposals', count: 5 });
});

test('the opening section is destination-driven', () => {
  expect(defaultSectionForMode('harden')).toBe('proposals');
  expect(defaultSectionForMode('enforce')).toBe('conventions');
  expect(defaultSectionForMode(undefined)).toBe('conventions');
});

test('the RepoProfile banner rides the PROPOSE half only', () => {
  expect(showProfileBannerForMode('harden')).toBe(true);
  expect(showProfileBannerForMode(undefined)).toBe(true);
  expect(showProfileBannerForMode('enforce')).toBe(false);
});
