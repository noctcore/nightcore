import type { GauntletResult, Task, TaskStatus } from '@/lib/bridge';

/** Build a Task fixture for stories/tests. Mirrors the frozen M1 shape. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const now = 1_718_900_000_000;
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Webpack → Vite migration',
    description:
      overrides.description ??
      'Migrate the build pipeline from Webpack to Vite for faster cold starts.',
    status: overrides.status ?? 'backlog',
    dependencies: overrides.dependencies ?? [],
    model: overrides.model ?? 'opus-4.8',
    branch: overrides.branch ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    sessionId: overrides.sessionId ?? null,
    summary: overrides.summary ?? null,
    error: overrides.error ?? null,
    costUsd: overrides.costUsd ?? null,
    plan: overrides.plan ?? null,
    committed: overrides.committed ?? false,
    merged: overrides.merged ?? false,
    conflict: overrides.conflict ?? false,
    kind: overrides.kind ?? 'build',
    verified: overrides.verified ?? false,
    review: overrides.review ?? null,
    fixAttempts: overrides.fixAttempts ?? 0,
  };
}

/** A sample reviewer verdict requesting changes, ending with the machine-readable
 *  line the core greps for. Drives the ReviewPanel + verified-card stories/tests. */
export const SAMPLE_REVIEW_CHANGES =
  'The migration backfills the new column but never guards against a null email,\n' +
  'so existing rows with no address violate the NOT NULL constraint.\n\n' +
  'Required fixes:\n' +
  '1. Default the backfill to an empty string when email is null.\n' +
  '2. Add a test over a row with a null email.\n\n' +
  'VERDICT: CHANGES_REQUESTED';

/** A passing reviewer verdict. */
export const SAMPLE_REVIEW_PASS =
  'The auth guard covers every protected route and the tests exercise the\n' +
  'unauthenticated path. The diff is complete and correct.\n\nVERDICT: PASS';

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
    costUsd: 0.18,
  }),
  verifying: makeTask({
    id: 't-verifying',
    status: 'verifying',
    title: 'Add rate limiter middleware',
    model: 'sonnet-4.6',
    branch: 'nc/rate-limiter',
    costUsd: 0.27,
  }),
  waiting_approval: makeTask({
    id: 't-waiting',
    status: 'waiting_approval',
    title: 'Apply destructive migration',
    branch: 'nc/destructive-migration',
    costUsd: 0.42,
    review: SAMPLE_REVIEW_CHANGES,
    fixAttempts: 2,
  }),
  done: makeTask({
    id: 't-done',
    status: 'done',
    title: 'Wire up auth guard',
    branch: 'nc/auth-guard',
    costUsd: 0.42,
    verified: true,
    review: SAMPLE_REVIEW_PASS,
  }),
  failed: makeTask({
    id: 't-failed',
    status: 'failed',
    title: 'Webpack → Vite migration',
    branch: 'nc/vite-migrate',
    error: "cannot resolve 'sass-loader'",
    costUsd: 0.58,
  }),
};

/** A passing readiness-gauntlet result (typecheck → lint → test all green). */
export const GAUNTLET_PASSED: GauntletResult = {
  passed: true,
  steps: [
    { name: 'typecheck', command: 'bun run typecheck', status: 'passed', exitCode: 0 },
    { name: 'lint', command: 'bun run lint', status: 'passed', exitCode: 0 },
    { name: 'test', command: 'bun run test', status: 'passed', exitCode: 0 },
  ],
};

/** A failing gauntlet — `test` fails, so it is the failed step and lint never
 *  ran (the runner stops at the first non-zero exit). */
export const GAUNTLET_FAILED: GauntletResult = {
  passed: false,
  failedStep: 'test',
  steps: [
    { name: 'typecheck', command: 'bun run typecheck', status: 'passed', exitCode: 0 },
    { name: 'test', command: 'bun run test', status: 'failed', exitCode: 1 },
    { name: 'lint', command: 'bun run lint', status: 'skipped' },
  ],
};

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
