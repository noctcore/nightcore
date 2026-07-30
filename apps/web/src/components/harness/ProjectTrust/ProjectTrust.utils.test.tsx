import { expect, test } from 'vitest';

import {
  badgeSwatchClass,
  formatJournalTime,
  formatPassRate,
  formatUsd,
  journalKindLabel,
  journalKindTone,
} from './ProjectTrust.utils';

test('a never-run gauntlet reads as an em dash, never as 0%', () => {
  expect(formatPassRate(null)).toBe('—');
  expect(formatPassRate(undefined)).toBe('—');
  expect(formatPassRate(Number.NaN)).toBe('—');
  expect(formatPassRate(0)).toBe('0%');
  expect(formatPassRate(1)).toBe('100%');
  expect(formatPassRate(32 / 34)).toBe('94%');
});

test('spend renders at cent precision', () => {
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(41.874)).toBe('$41.87');
  expect(formatUsd(2)).toBe('$2.00');
});

test('a journal timestamp renders as a compact UTC stamp, not a relative age', () => {
  expect(formatJournalTime('2026-07-29T13:58:11Z')).toBe('2026-07-29 13:58');
  // A value in any other shape passes through rather than being mangled.
  expect(formatJournalTime('whenever')).toBe('whenever');
  expect(formatJournalTime('')).toBe('');
});

test('every known governance kind gets a label and a tone', () => {
  expect(journalKindLabel('quarantine')).toBe('Quarantined');
  expect(journalKindLabel('policy-save')).toBe('Policy saved');
  expect(journalKindLabel('arm')).toBe('Armed');
  expect(journalKindLabel('disarm')).toBe('Disarmed');
  expect(journalKindLabel('ratchet')).toBe('Ratchet');
  // Tightening a rail reads as success; loosening one as a warning.
  expect(journalKindTone('arm')).toBe('success');
  expect(journalKindTone('ratchet')).toBe('success');
  expect(journalKindTone('disarm')).toBe('warning');
});

test('a kind this build does not know stays visible and attributable', () => {
  expect(journalKindLabel('future-kind')).toBe('future-kind');
  expect(journalKindTone('future-kind')).toBe('neutral');
});

test('every shields colour the posture can emit has a swatch', () => {
  for (const color of ['brightgreen', 'green', 'yellow', 'orange', 'red', 'lightgrey']) {
    expect(badgeSwatchClass(color)).not.toBe('');
  }
  expect(badgeSwatchClass('chartreuse')).toBe('bg-muted-foreground/60');
});
