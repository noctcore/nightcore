import type { WorktreeInfo } from '@/lib/bridge';

/** Live worktrees for the switcher's stories/tests — one dirty + ahead, one
 *  clean. Mirrors the `list_worktrees` shape; branches match the worktree-mode
 *  task fixtures in `_fixtures.task.ts` so the switcher groups them. */
export const WORKTREES: WorktreeInfo[] = [
  {
    branch: 'nc/api-client',
    path: '~/dev/nightcore/.worktrees/nc-api-client',
    taskIds: ['t-running'],
    dirty: true,
    aheadOfBase: 2,
    behindOfBase: 0,
    changedFiles: 3,
  },
  {
    branch: 'nc/auth-guard',
    path: '~/dev/nightcore/.worktrees/nc-auth-guard',
    taskIds: ['t-done'],
    dirty: false,
    aheadOfBase: 1,
    behindOfBase: 0,
    changedFiles: 0,
  },
];

/** A larger worktree set (6) that trips the switcher's collapse threshold, mixing
 *  clean / dirty / ahead / behind / diverged states so the collapsed select's
 *  aggregate (running spinner + diverged badge) and per-row chips have something
 *  to show. Branches match `MANY_WORKTREE_TASKS` in `_fixtures.task.ts` so the
 *  select is searchable by task title, and two carry a running task so the
 *  aggregate spinner appears. */
export const MANY_WORKTREES: WorktreeInfo[] = [
  {
    branch: 'nc/api-client',
    path: '~/dev/nightcore/.worktrees/nc-api-client',
    taskIds: ['mw-api'],
    dirty: true,
    aheadOfBase: 2,
    behindOfBase: 0,
    changedFiles: 3,
  },
  {
    branch: 'nc/auth-guard',
    path: '~/dev/nightcore/.worktrees/nc-auth-guard',
    taskIds: ['mw-auth'],
    dirty: false,
    aheadOfBase: 1,
    behindOfBase: 0,
    changedFiles: 0,
  },
  {
    branch: 'nc/rate-limiter',
    path: '~/dev/nightcore/.worktrees/nc-rate-limiter',
    taskIds: ['mw-rate'],
    dirty: true,
    aheadOfBase: 3,
    behindOfBase: 1,
    changedFiles: 4,
  },
  {
    branch: 'nc/dark-mode',
    path: '~/dev/nightcore/.worktrees/nc-dark-mode',
    taskIds: ['mw-dark'],
    dirty: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    changedFiles: 0,
  },
  {
    branch: 'nc/telemetry',
    path: '~/dev/nightcore/.worktrees/nc-telemetry',
    taskIds: ['mw-tel'],
    dirty: true,
    aheadOfBase: 0,
    behindOfBase: 2,
    changedFiles: 1,
  },
  {
    branch: 'nc/search-index',
    path: '~/dev/nightcore/.worktrees/nc-search-index',
    taskIds: ['mw-search'],
    dirty: false,
    aheadOfBase: 5,
    behindOfBase: 4,
    changedFiles: 0,
  },
];
