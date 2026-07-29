import { describe, expect, it } from 'vitest';

import { makeTask } from './_fixtures.task';
import {
  chainEdits,
  pruneSelection,
  selectedInLaunchOrder,
  toggleSelection,
  unchainEdits,
} from './selection';

const ONE = makeTask({ id: 'one', title: 'One', createdAt: 10 });
const TWO = makeTask({ id: 'two', title: 'Two', createdAt: 20 });
const THREE = makeTask({ id: 'three', title: 'Three', createdAt: 30 });

describe('toggleSelection', () => {
  it('adds a missing id and removes a present one, always returning a new set', () => {
    const empty = new Set<string>();
    const added = toggleSelection(empty, 'a');
    expect([...added]).toEqual(['a']);
    expect(added).not.toBe(empty);
    expect([...toggleSelection(added, 'a')]).toEqual([]);
  });
});

describe('pruneSelection', () => {
  it('drops ids that no longer name a live task', () => {
    const pruned = pruneSelection(new Set(['one', 'deleted']), [ONE, TWO]);
    expect([...pruned]).toEqual(['one']);
  });

  it('returns the SAME reference when nothing is stale (so the memo bails)', () => {
    const selected = new Set(['one', 'two']);
    expect(pruneSelection(selected, [ONE, TWO])).toBe(selected);
  });

  it('short-circuits an empty selection', () => {
    const empty = new Set<string>();
    expect(pruneSelection(empty, [])).toBe(empty);
  });
});

describe('selectedInLaunchOrder', () => {
  it('orders by createdAt then id — the coordinator’s own tiebreak, not click order', () => {
    const tie = makeTask({ id: 'a-tie', title: 'Tie', createdAt: 10 });
    const ordered = selectedInLaunchOrder(
      [THREE, TWO, ONE, tie],
      new Set(['three', 'two', 'one', 'a-tie']),
    );
    expect(ordered.map((t) => t.id)).toEqual(['a-tie', 'one', 'two', 'three']);
  });

  it('ignores unselected tasks', () => {
    expect(selectedInLaunchOrder([ONE, TWO], new Set(['two'])).map((t) => t.id)).toEqual([
      'two',
    ]);
  });
});

describe('chainEdits', () => {
  it('links each task to its predecessor', () => {
    expect(chainEdits([ONE, TWO, THREE])).toEqual([
      { id: 'two', dependencies: ['one'] },
      { id: 'three', dependencies: ['two'] },
    ]);
  });

  it('PRESERVES dependencies the task already declares (adds an edge, never drops one)', () => {
    const two = makeTask({ id: 'two', createdAt: 20, dependencies: ['outside'] });
    expect(chainEdits([ONE, two])).toEqual([
      { id: 'two', dependencies: ['outside', 'one'] },
    ]);
  });

  it('is a no-op for an already-chained selection (re-chaining changes nothing)', () => {
    const two = makeTask({ id: 'two', createdAt: 20, dependencies: ['one'] });
    const three = makeTask({ id: 'three', createdAt: 30, dependencies: ['two'] });
    expect(chainEdits([ONE, two, three])).toEqual([]);
  });

  it('needs at least two tasks', () => {
    expect(chainEdits([])).toEqual([]);
    expect(chainEdits([ONE])).toEqual([]);
  });
});

describe('unchainEdits', () => {
  it('drops only edges pointing at another SELECTED task', () => {
    const two = makeTask({ id: 'two', createdAt: 20, dependencies: ['one', 'outside'] });
    const three = makeTask({ id: 'three', createdAt: 30, dependencies: ['two'] });
    expect(unchainEdits([ONE, two, three])).toEqual([
      { id: 'two', dependencies: ['outside'] },
      { id: 'three', dependencies: [] },
    ]);
  });

  it('is the exact inverse of chainEdits', () => {
    const chained = [
      ONE,
      makeTask({ id: 'two', createdAt: 20, dependencies: ['one'] }),
      makeTask({ id: 'three', createdAt: 30, dependencies: ['two'] }),
    ];
    expect(unchainEdits(chained)).toEqual([
      { id: 'two', dependencies: [] },
      { id: 'three', dependencies: [] },
    ]);
  });

  it('yields nothing when the selection has no internal edges', () => {
    expect(unchainEdits([ONE, TWO, THREE])).toEqual([]);
  });
});
