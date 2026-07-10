import { expect, test } from 'vitest';

import { parseSourceRef, sourceRefLabel } from './source-ref';

test('legacy schemes keep parsing after the stage remap', () => {
  // The Rust mint PREFIXES are frozen, but the Phase-1 stage flip retargeted each
  // to the STAGE that now hosts it (via the source-ref REGISTRY): Insight +
  // Scorecard fold into the Understand stage (split by `family`), Harness
  // conventions land on Enforce, task-shaped proposals on Harden. The `kind` /
  // `runId` / `itemId` are unchanged — old provenance tokens route without a
  // migration.
  expect(parseSourceRef('insight:run-1:finding-9')).toEqual({
    view: 'understand',
    family: 'insight',
    kind: 'finding',
    runId: 'run-1',
    itemId: 'finding-9',
  });
  expect(parseSourceRef('scorecard:run-2:reading-3')).toEqual({
    view: 'understand',
    family: 'scorecard',
    kind: 'reading',
    runId: 'run-2',
    itemId: 'reading-3',
  });
  expect(parseSourceRef('harness:run-4:conv-1')).toEqual({
    view: 'enforce',
    family: 'harness',
    kind: 'finding',
    runId: 'run-4',
    itemId: 'conv-1',
  });
  expect(parseSourceRef('harness-proposal:run-4:prop-2')).toEqual({
    view: 'harden',
    family: 'harness',
    kind: 'proposal',
    runId: 'run-4',
    itemId: 'prop-2',
  });
});

test('parses the run-level issue-triage scheme (2-segment token, empty itemId)', () => {
  // The Rust convert mints `issue-triage:<runId>` (no item — the run IS the item).
  // The KEY is hyphenated; the AppView it targets is not (`issuetriage`). Issue
  // Triage keeps its own destination through the stage flip (an Intake child).
  expect(parseSourceRef('issue-triage:val-7')).toEqual({
    view: 'issuetriage',
    family: 'issue-triage',
    kind: 'validation',
    runId: 'val-7',
    itemId: '',
  });
  // A stray third segment is tolerated and kept as the itemId.
  expect(parseSourceRef('issue-triage:val-7:extra')).toEqual({
    view: 'issuetriage',
    family: 'issue-triage',
    kind: 'validation',
    runId: 'val-7',
    itemId: 'extra',
  });
});

test('the pr-review scheme keeps its own destination after the remap', () => {
  // PR Review is a Verify-stage child with its own destination (unchanged view).
  expect(parseSourceRef('pr-review:run-5:sf-1')).toEqual({
    view: 'prreview',
    family: 'pr-review',
    kind: 'finding',
    runId: 'run-5',
    itemId: 'sf-1',
  });
});

test('keeps colons inside the item id — only the first two separators are structural', () => {
  expect(parseSourceRef('insight:run-1:file.ts:12')).toEqual({
    view: 'understand',
    family: 'insight',
    kind: 'finding',
    runId: 'run-1',
    itemId: 'file.ts:12',
  });
});

test('returns null for unknown schemes and malformed tokens', () => {
  expect(parseSourceRef('mystery:run:item')).toBeNull();
  expect(parseSourceRef('insight')).toBeNull();
  expect(parseSourceRef('insight:run-only')).toBeNull();
  expect(parseSourceRef('insight::item')).toBeNull();
  expect(parseSourceRef('insight:run:')).toBeNull();
  expect(parseSourceRef('')).toBeNull();
});

test('labels known schemes and degrades unknown/absent ones to null', () => {
  expect(sourceRefLabel('insight:r:i')).toBe('Insight finding');
  expect(sourceRefLabel('scorecard:r:i')).toBe('Scorecard reading');
  expect(sourceRefLabel('harness:r:i')).toBe('Harness convention');
  expect(sourceRefLabel('harness-proposal:r:i')).toBe('Harness proposal');
  expect(sourceRefLabel('issue-triage:val-7')).toBe('Issue validation');
  expect(sourceRefLabel('mystery:r:i')).toBeNull();
  expect(sourceRefLabel(null)).toBeNull();
});
