import { describe, expect, it } from 'vitest';

import type { RunOrderProjection } from '@/lib/bridge';

import { makeTask } from '../_fixtures.task';
import { EMPTY_RUN_ORDER } from '../run-order';
import { runOrderRows, unreachableRows } from './RunOrderPanel.utils';

const TASKS = [
  makeTask({ id: 'one', title: 'Extract the settings store', createdAt: 10 }),
  makeTask({ id: 'two', title: '', createdAt: 20 }),
];

function projection(overrides: Partial<RunOrderProjection> = {}): RunOrderProjection {
  return { ...EMPTY_RUN_ORDER, ...overrides };
}

describe('runOrderRows', () => {
  it('preserves the BACKEND order verbatim (never re-sorts)', () => {
    // Deliberately hand the entries in a non-position order: the join must not reorder.
    const rows = runOrderRows(
      projection({
        entries: [
          { taskId: 'two', position: 2, wave: 1, startsNow: false, blockedBy: ['one'] },
          { taskId: 'one', position: 1, wave: 0, startsNow: true, blockedBy: [] },
        ],
      }),
      TASKS,
    );
    expect(rows.map((r) => r.id)).toEqual(['two', 'one']);
  });

  it('resolves blockers to titles, naming a deleted dependency', () => {
    const rows = runOrderRows(
      projection({
        entries: [
          { taskId: 'one', position: 1, wave: 1, startsNow: false, blockedBy: ['gone', 'two'] },
        ],
      }),
      TASKS,
    );
    expect(rows[0]?.blockedBy).toEqual(['a deleted task', 'Untitled task']);
  });

  it('drops an entry whose task is absent (a delete racing the refetch)', () => {
    const rows = runOrderRows(
      projection({
        entries: [{ taskId: 'vanished', position: 1, wave: 0, startsNow: true, blockedBy: [] }],
      }),
      TASKS,
    );
    expect(rows).toEqual([]);
  });
});

describe('unreachableRows', () => {
  it('resolves the never-eligible ids to titles', () => {
    const rows = unreachableRows(projection({ unreachable: ['one'] }), TASKS);
    expect(rows).toEqual([{ id: 'one', title: 'Extract the settings store' }]);
  });

  it('drops ids whose task is gone', () => {
    expect(unreachableRows(projection({ unreachable: ['ghost'] }), TASKS)).toEqual([]);
  });
});
