import { expect, test } from 'vitest';

import { STAGE_BY_ID, STAGE_ORDER, stageNumber,STAGES } from './stages';

test('the lifecycle is the five stages in order', () => {
  expect(STAGE_ORDER).toEqual(['intake', 'understand', 'harden', 'enforce', 'verify']);
  expect(STAGES).toHaveLength(5);
});

test('every stage carries the copy the explainers render', () => {
  for (const stage of STAGES) {
    // A blank field would render an empty explainer — the exact failure mode this
    // module exists to prevent.
    expect(stage.label.length).toBeGreaterThan(0);
    expect(stage.destination.length).toBeGreaterThan(0);
    expect(stage.verb.length).toBeGreaterThan(0);
    expect(stage.summary.length).toBeGreaterThan(20);
    expect(stage.produces.length).toBeGreaterThan(0);
    expect(STAGE_BY_ID[stage.id]).toBe(stage);
  }
});

test('stage numbers are 1-based lifecycle positions', () => {
  expect(stageNumber('intake')).toBe(1);
  expect(stageNumber('verify')).toBe(5);
  expect(STAGES.map((s) => stageNumber(s.id))).toEqual([1, 2, 3, 4, 5]);
});
