import { expect, test } from 'vitest';
import type { Task } from '@/lib/bridge';
import { isAutoCommitTarget, isCommitIsolated, planAutoCommits } from './useAutoCommit.hooks';

/** A full Task with benign defaults; the planner reads only id/status/verified/
 *  committed/merged/runMode, but the factory stays type-safe so a Task field change
 *  is caught. */
const BASE: Task = {
  id: 't',
  title: '',
  description: '',
  status: 'done',
  dependencies: [],
  model: null,
  effort: null,
  permissionMode: null,
  branch: null,
  createdAt: 0,
  updatedAt: 0,
  sessionId: null,
  summary: null,
  error: null,
  costUsd: null,
  plan: null,
  committed: false,
  merged: false,
  conflict: false,
  kind: 'build',
  runMode: 'main',
  verified: false,
  review: null,
  fixAttempts: 0,
  structureLockResult: null,
  maxTurns: null,
  maxBudgetUsd: null,
  sdkSessionId: null,
  seq: 0,
  attachments: [],
  parentTaskId: null,
  proposedSubtasks: [],
};

const task = (overrides: Partial<Task>): Task => ({ ...BASE, ...overrides });
/** A verified-uncommitted main-mode task (a commit target on the shared root). */
const verified = (id: string): Task =>
  task({ id, runMode: 'main', status: 'done', verified: true, committed: false });
/** A verified-uncommitted worktree-mode task (a commit target, isolated). */
const verifiedWorktree = (id: string): Task =>
  task({ id, runMode: 'worktree', status: 'done', verified: true, committed: false });

const ids = (plan: { commits: Task[] }): string[] => plan.commits.map((t) => t.id);

test('inactive: commits nothing and clears the handled set', () => {
  const plan = planAutoCommits({
    tasks: [verified('a')],
    active: false,
    wasActive: true,
    handled: new Set(['a']),
  });
  expect(plan.commits).toEqual([]);
  expect(plan.nextActive).toBe(false);
  expect([...plan.nextHandled]).toEqual([]);
});

test('activation seeds existing verified tasks — no retroactive batch-commit', () => {
  const plan = planAutoCommits({
    tasks: [verified('a'), verified('b')],
    active: true,
    wasActive: false,
    handled: new Set(),
  });
  expect(plan.commits).toEqual([]);
  expect(plan.nextActive).toBe(true);
  expect(plan.nextHandled).toEqual(new Set(['a', 'b']));
});

test('steady-state: commits a newly verified, isolated task exactly once', () => {
  const plan = planAutoCommits({
    tasks: [verified('a')],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(ids(plan)).toEqual(['a']);
  expect(plan.nextHandled.has('a')).toBe(true);
});

test('dedupe: an already-handled verified task is not re-committed (no spin)', () => {
  const plan = planAutoCommits({
    tasks: [verified('a')],
    active: true,
    wasActive: true,
    handled: new Set(['a']),
  });
  expect(plan.commits).toEqual([]);
});

test('re-arm: a handled task that left Done is pruned, so a re-verify commits again', () => {
  // 'a' was handled, then re-ran → now in_progress. It must be pruned this pass.
  const running = planAutoCommits({
    tasks: [task({ id: 'a', runMode: 'main', status: 'in_progress', verified: false })],
    active: true,
    wasActive: true,
    handled: new Set(['a']),
  });
  expect(running.nextHandled.has('a')).toBe(false);

  // Next pass it verifies again (alone) → auto-commit fires once more.
  const reverified = planAutoCommits({
    tasks: [verified('a')],
    active: true,
    wasActive: true,
    handled: running.nextHandled,
  });
  expect(ids(reverified)).toEqual(['a']);
});

test('skips already-committed, done-but-unverified, and still-verifying tasks', () => {
  const plan = planAutoCommits({
    tasks: [
      task({ id: 'committed', status: 'done', verified: true, committed: true }),
      task({ id: 'doneNotVerified', status: 'done', verified: false }),
      task({ id: 'verifying', status: 'verifying', verified: false }),
    ],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(plan.commits).toEqual([]);
});

test('isolation: two verified main-mode tasks block each other (shared root)', () => {
  // Committing either with `git add -A` would sweep the other's edits → commit
  // neither; both stay unhandled so they retry once the root clears.
  const plan = planAutoCommits({
    tasks: [verified('a'), verified('b')],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(plan.commits).toEqual([]);
  expect(plan.nextHandled.has('a')).toBe(false);
  expect(plan.nextHandled.has('b')).toBe(false);
});

test('isolation: a verified main task is skipped (not handled) while a sibling main task runs', () => {
  const plan = planAutoCommits({
    tasks: [verified('a'), task({ id: 'b', runMode: 'main', status: 'in_progress' })],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(plan.commits).toEqual([]);
  // Not marked handled → it will commit once 'b' finishes and the root clears.
  expect(plan.nextHandled.has('a')).toBe(false);
});

test('isolation: worktree tasks are always isolated — a verified worktree task commits even amid other work', () => {
  const plan = planAutoCommits({
    tasks: [
      verifiedWorktree('w'),
      task({ id: 'b', runMode: 'main', status: 'in_progress' }),
      task({ id: 'c', runMode: 'worktree', status: 'in_progress' }),
    ],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(ids(plan)).toEqual(['w']);
});

test('isolation: a verified main task commits once its only main sibling is already committed', () => {
  const plan = planAutoCommits({
    tasks: [verified('a'), task({ id: 'b', runMode: 'main', status: 'done', verified: true, committed: true })],
    active: true,
    wasActive: true,
    handled: new Set(),
  });
  expect(ids(plan)).toEqual(['a']);
});

test('isCommitIsolated: worktree always; main only when no other main task holds uncommitted work', () => {
  const a = verified('a');
  const runningMain = task({ id: 'b', runMode: 'main', status: 'in_progress' });
  const doneUncommittedMain = task({ id: 'c', runMode: 'main', status: 'done', verified: true });
  const committedMain = task({ id: 'd', runMode: 'main', status: 'done', committed: true });
  const readyMain = task({ id: 'e', runMode: 'main', status: 'ready' });

  expect(isCommitIsolated(verifiedWorktree('w'), [verifiedWorktree('w'), runningMain])).toBe(true);
  expect(isCommitIsolated(a, [a])).toBe(true);
  expect(isCommitIsolated(a, [a, runningMain])).toBe(false);
  expect(isCommitIsolated(a, [a, doneUncommittedMain])).toBe(false);
  // A committed or not-yet-run sibling holds no uncommitted root work.
  expect(isCommitIsolated(a, [a, committedMain])).toBe(true);
  expect(isCommitIsolated(a, [a, readyMain])).toBe(true);
});

test('isAutoCommitTarget: only Done + verified + not-committed qualifies', () => {
  expect(isAutoCommitTarget(verified('a'))).toBe(true);
  expect(isAutoCommitTarget(task({ status: 'done', verified: true, committed: true }))).toBe(false);
  expect(isAutoCommitTarget(task({ status: 'verifying', verified: false }))).toBe(false);
  expect(isAutoCommitTarget(task({ status: 'done', verified: false }))).toBe(false);
});
