import type { Task, TaskStatus } from '@/lib/bridge';

import { SAMPLE_REVIEW_CHANGES, SAMPLE_REVIEW_PASS } from './_fixtures.review';
import type { TaskDetailActions } from './actions';

/** Build a grouped task-actions fixture for `TaskActionsProvider` in stories and
 *  tests: the required handlers stubbed as no-ops, with any subset overridden
 *  (typically a spy for the handler under test). Explicitly-`undefined` overrides
 *  are dropped so a fixture wrapper can forward optional story args verbatim
 *  without clobbering the required no-op base. */
export function makeTaskActions(
  overrides: Partial<TaskDetailActions> = {},
): TaskDetailActions {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<TaskDetailActions>;
  return {
    onSelect: () => {},
    onRun: () => {},
    onCancel: () => {},
    onDelete: () => {},
    ...defined,
  };
}

/** Build a Task fixture for stories/tests. Mirrors the canonical Task shape. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const now = 1_718_900_000_000;
  return {
    seq: overrides.seq ?? 0,
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Webpack → Vite migration',
    description:
      overrides.description ??
      'Migrate the build pipeline from Webpack to Vite for faster cold starts.',
    status: overrides.status ?? 'backlog',
    dependencies: overrides.dependencies ?? [],
    model: overrides.model ?? 'opus-4.8',
    effort: overrides.effort ?? null,
    permissionMode: overrides.permissionMode ?? null,
    branch: overrides.branch ?? null,
    baseBranch: overrides.baseBranch,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    sessionId: overrides.sessionId ?? null,
    sdkSessionId: overrides.sdkSessionId ?? null,
    summary: overrides.summary ?? null,
    error: overrides.error ?? null,
    costUsd: overrides.costUsd ?? null,
    plan: overrides.plan ?? null,
    committed: overrides.committed ?? false,
    merged: overrides.merged ?? false,
    conflict: overrides.conflict ?? false,
    prUrl: overrides.prUrl,
    prNumber: overrides.prNumber,
    kind: overrides.kind ?? 'build',
    runMode: overrides.runMode ?? 'main',
    verified: overrides.verified ?? false,
    review: overrides.review ?? null,
    fixAttempts: overrides.fixAttempts ?? 0,
    structureLockResult: overrides.structureLockResult ?? null,
    verifyCommand: overrides.verifyCommand ?? null,
    maxTurns: overrides.maxTurns ?? null,
    maxBudgetUsd: overrides.maxBudgetUsd ?? null,
    attachments: overrides.attachments ?? [],
    parentTaskId: overrides.parentTaskId ?? null,
    proposedSubtasks: overrides.proposedSubtasks ?? [],
    sourceRef: overrides.sourceRef ?? null,
    // GitHub two-way sync (#97) — serde-additive optional fields; passed through
    // verbatim (omitted-while-unset), like `prUrl`/`prNumber`/`baseBranch`.
    issueNumber: overrides.issueNumber,
    issueSyncedLabel: overrides.issueSyncedLabel,
    issueSyncedAt: overrides.issueSyncedAt,
    issueCommentMarker: overrides.issueCommentMarker,
    issueState: overrides.issueState,
    issueSyncError: overrides.issueSyncError,
  };
}

/** One task per board status, for "each status" card stories. Enriched to match
 *  the design's card anatomy: model badges, branches, costs, deps, and errors. */
export const TASKS_BY_STATUS: Record<TaskStatus, Task> = {
  backlog: makeTask({ id: 't-backlog', status: 'backlog' }),
  ready: makeTask({ id: 't-ready', status: 'ready', title: 'Add dark-mode toggle' }),
  in_progress: makeTask({
    id: 't-running',
    status: 'in_progress',
    title: 'Generate API client',
    model: 'sonnet-4.6',
    branch: 'nc/api-client',
    runMode: 'worktree',
    costUsd: 0.18,
  }),
  verifying: makeTask({
    id: 't-verifying',
    status: 'verifying',
    title: 'Add rate limiter middleware',
    model: 'sonnet-4.6',
    branch: 'nc/rate-limiter',
    runMode: 'worktree',
    costUsd: 0.27,
  }),
  waiting_approval: makeTask({
    id: 't-waiting',
    status: 'waiting_approval',
    title: 'Apply destructive migration',
    branch: 'nc/destructive-migration',
    runMode: 'worktree',
    costUsd: 0.42,
    review: SAMPLE_REVIEW_CHANGES,
    fixAttempts: 2,
  }),
  done: makeTask({
    id: 't-done',
    status: 'done',
    title: 'Wire up auth guard',
    branch: 'nc/auth-guard',
    runMode: 'worktree',
    costUsd: 0.42,
    verified: true,
    review: SAMPLE_REVIEW_PASS,
  }),
  failed: makeTask({
    id: 't-failed',
    status: 'failed',
    title: 'Webpack → Vite migration',
    branch: 'nc/vite-migrate',
    runMode: 'worktree',
    error: "cannot resolve 'sass-loader'",
    costUsd: 0.58,
  }),
};

/** A `main`-mode task — edits the project tree in place, so it has no branch.
 *  Exercises the card's "main" chip and the suppressed Merge action. */
export const MAIN_MODE_TASK: Task = makeTask({
  id: 't-main',
  status: 'done',
  title: 'Tidy the README',
  description: 'Small in-place doc edit on the current branch.',
  runMode: 'main',
  branch: null,
  costUsd: 0.04,
  verified: true,
  committed: true,
  review: SAMPLE_REVIEW_PASS,
});

/** A worktree-mode task the coordinator has NOT yet named a branch for — the normal
 *  pre-submit state (`branch: null`). It belongs on the Main board until it has a
 *  branch/worktree; without the Main-tab fix it is unreachable from every tab. */
export const PENDING_WORKTREE_TASK: Task = makeTask({
  id: 't-pending-worktree',
  status: 'backlog',
  title: 'Extract the settings store',
  runMode: 'worktree',
  branch: null,
});

/** A worktree-mode task WITH a branch whose live worktree directory does not exist
 *  (not created yet, or already pruned). It must still get its own tab. */
export const ORPHAN_BRANCH_TASK: Task = makeTask({
  id: 't-orphan-branch',
  status: 'backlog',
  title: 'Trim the shiki bundle',
  runMode: 'worktree',
  branch: 'nc/shiki-trim',
});

/** Tasks pinned to the `MANY_WORKTREES` branches in `_fixtures.worktree.ts` — two
 *  are actively running (in_progress / verifying) so the collapsed select's
 *  aggregate spinner + per-row running dot render, and each carries a searchable
 *  title. */
export const MANY_WORKTREE_TASKS: Task[] = [
  makeTask({
    id: 'mw-api',
    title: 'Generate API client',
    status: 'in_progress',
    runMode: 'worktree',
    branch: 'nc/api-client',
  }),
  makeTask({
    id: 'mw-auth',
    title: 'Wire up auth guard',
    status: 'done',
    runMode: 'worktree',
    branch: 'nc/auth-guard',
    verified: true,
  }),
  makeTask({
    id: 'mw-rate',
    title: 'Add rate limiter middleware',
    status: 'backlog',
    runMode: 'worktree',
    branch: 'nc/rate-limiter',
  }),
  makeTask({
    id: 'mw-dark',
    title: 'Add dark-mode toggle',
    status: 'backlog',
    runMode: 'worktree',
    branch: 'nc/dark-mode',
  }),
  makeTask({
    id: 'mw-tel',
    title: 'Ship telemetry pipeline',
    status: 'backlog',
    runMode: 'worktree',
    branch: 'nc/telemetry',
  }),
  makeTask({
    id: 'mw-search',
    title: 'Build search index',
    status: 'verifying',
    runMode: 'worktree',
    branch: 'nc/search-index',
  }),
];

/** A backlog task blocked on an unfinished dependency — exercises the card's
 *  blocked chip and the disabled "Blocked" run action. */
export const BLOCKED_TASK: Task = makeTask({
  id: 't-blocked',
  status: 'backlog',
  title: 'Worktree cleanup policy',
  description:
    'Remove per-task worktrees once a task is verified and merged.',
  model: 'haiku-4.5',
  dependencies: ['Deployment configuration'],
});
