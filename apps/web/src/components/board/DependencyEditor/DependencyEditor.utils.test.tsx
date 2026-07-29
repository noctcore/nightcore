import { describe, expect, it } from 'vitest';

import { makeTask } from '../_fixtures.task';
import {
  dependencyCandidates,
  dependencyRows,
  wouldCycle,
} from './DependencyEditor.utils';

const A = makeTask({ id: 'a', title: 'Alpha', status: 'done', createdAt: 10 });
const B = makeTask({ id: 'b', title: 'Bravo', status: 'backlog', createdAt: 20 });
const C = makeTask({ id: 'c', title: 'Charlie', status: 'backlog', createdAt: 30 });

function index(tasks = [A, B, C]) {
  return new Map(tasks.map((t) => [t.id, t]));
}

describe('dependencyRows', () => {
  it('resolves declared ids to title + satisfied, in declaration order', () => {
    const task = makeTask({ id: 'x', dependencies: ['b', 'a'] });
    expect(dependencyRows(task, index())).toEqual([
      { id: 'b', title: 'Bravo', satisfied: false },
      { id: 'a', title: 'Alpha', satisfied: true },
    ]);
  });

  it('marks a dangling id unsatisfied with a null title (the backend fails closed)', () => {
    const task = makeTask({ id: 'x', dependencies: ['vanished'] });
    expect(dependencyRows(task, index())).toEqual([
      { id: 'vanished', title: null, satisfied: false },
    ]);
  });
});

describe('wouldCycle', () => {
  it('refuses a task depending on itself', () => {
    expect(wouldCycle('a', 'a', index())).toBe(true);
  });

  it('refuses the direct back-edge', () => {
    // b already depends on a → a depending on b closes the 2-cycle.
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    expect(wouldCycle('a', 'b', index([A, b, C]))).toBe(true);
  });

  it('refuses a transitive back-edge', () => {
    // c → b → a, so a depending on c would close a 3-cycle.
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    const c = makeTask({ id: 'c', dependencies: ['b'] });
    expect(wouldCycle('a', 'c', index([A, b, c]))).toBe(true);
  });

  it('allows an edge that only deepens the chain', () => {
    const b = makeTask({ id: 'b', dependencies: ['a'] });
    expect(wouldCycle('c', 'b', index([A, b, C]))).toBe(false);
  });

  it('terminates on a pre-existing stored cycle instead of hanging', () => {
    const b = makeTask({ id: 'b', dependencies: ['c'] });
    const c = makeTask({ id: 'c', dependencies: ['b'] });
    expect(wouldCycle('a', 'b', index([A, b, c]))).toBe(false);
  });

  it('treats an unknown candidate as safe (nothing to reach back through)', () => {
    expect(wouldCycle('a', 'ghost', index())).toBe(false);
  });
});

describe('dependencyCandidates', () => {
  it('excludes the task itself and its already-declared dependencies', () => {
    const task = makeTask({ id: 'a', dependencies: ['b'] });
    const ids = dependencyCandidates(task, [A, B, C], '').map((c) => c.task.id);
    expect(ids).toEqual(['c']);
  });

  it('orders candidates the way the coordinator launches them (createdAt, then id)', () => {
    const task = makeTask({ id: 'x', createdAt: 99 });
    // `a` and `a-tie` share createdAt 10, so the id breaks the tie ('a' < 'a-tie') —
    // exactly the Rust `eligible_tasks` tiebreak.
    const tie = makeTask({ id: 'a-tie', title: 'Tie', status: 'backlog', createdAt: 10 });
    const ids = dependencyCandidates(task, [C, B, tie, A], '').map((c) => c.task.id);
    expect(ids).toEqual(['a', 'a-tie', 'b', 'c']);
  });

  it('keyword-filters on the title, case-insensitively', () => {
    const task = makeTask({ id: 'x' });
    expect(dependencyCandidates(task, [A, B, C], 'BRA').map((c) => c.task.id)).toEqual(['b']);
    expect(dependencyCandidates(task, [A, B, C], '   ').map((c) => c.task.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps a cycle-forming candidate visible but reason-disabled', () => {
    const downstream = makeTask({ id: 'c', title: 'Charlie', createdAt: 30, dependencies: ['a'] });
    const candidates = dependencyCandidates(A, [A, B, downstream], '');
    const charlie = candidates.find((c) => c.task.id === 'c');
    expect(charlie).toBeDefined();
    expect(charlie?.blockedReason).toMatch(/cycle/i);
    expect(candidates.find((c) => c.task.id === 'b')?.blockedReason).toBeNull();
  });
});
