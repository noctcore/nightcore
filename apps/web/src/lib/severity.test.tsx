import { describe, expect, it } from 'vitest';

import { SeveritySchema } from '@nightcore/contracts';

import {
  SEVERITY_META,
  SEVERITY_ORDER,
  severityRankValue,
  sortBySeverityThenStatus,
} from './severity';

/** Issue #178 deleted this module's hand-written severity union in favour of the
 *  contract enum. These pin the derivation so the web's display order and badge
 *  palette can never fall out of step with the scale itself. */
describe('SEVERITY_ORDER', () => {
  it('covers exactly the contract scale', () => {
    expect([...SEVERITY_ORDER].sort()).toEqual([...SeveritySchema.options].sort());
  });

  it('is the contract order reversed — highest severity first', () => {
    expect(SEVERITY_ORDER).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('has a badge palette entry for every level', () => {
    for (const severity of SEVERITY_ORDER) {
      expect(SEVERITY_META[severity]?.label).toBeTruthy();
    }
  });
});

describe('severityRankValue', () => {
  it('ranks strictly descending down SEVERITY_ORDER', () => {
    const ranks = SEVERITY_ORDER.map(severityRankValue);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]).toBeLessThan(ranks[i - 1]!);
    }
  });
});

describe('sortBySeverityThenStatus', () => {
  it('puts open before resolved, then severity high→low', () => {
    const items = [
      { id: 'a', status: 'dismissed', severity: 'critical' } as const,
      { id: 'b', status: 'open', severity: 'low' } as const,
      { id: 'c', status: 'open', severity: 'critical' } as const,
    ];
    expect(sortBySeverityThenStatus(items).map((i) => i.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('does not mutate its input', () => {
    const items = [
      { status: 'open', severity: 'low' } as const,
      { status: 'open', severity: 'high' } as const,
    ];
    const before = [...items];
    sortBySeverityThenStatus(items);
    expect(items).toEqual(before);
  });
});
