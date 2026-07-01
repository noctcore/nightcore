import { useEffect, useRef } from 'react';
import { commitTask, type Task } from '@/lib/bridge';
import type { ToastApi } from '@/components/ui';
import type { ActionGuard } from './useActionGuard.hooks';

/** A task the loop should auto-commit: it reached the verified state (`Done` +
 *  `verified`) and hasn't been committed yet. */
export function isAutoCommitTarget(task: Task): boolean {
  return task.status === 'done' && task.verified && !task.committed;
}

/** A main-mode task whose edits may sit uncommitted in the SHARED project root: it
 *  has run (not still backlog/ready) and isn't yet committed or merged. Used to
 *  detect when committing one main-mode task would sweep another's work. */
function holdsUncommittedRootWork(task: Task): boolean {
  return (
    task.runMode === 'main' &&
    !task.committed &&
    !task.merged &&
    task.status !== 'backlog' &&
    task.status !== 'ready'
  );
}

/**
 * Whether committing `target` captures only its own changes.
 *
 * A worktree-mode task commits its isolated `nc/<id>` worktree — always safe. A
 * main-mode task commits the SHARED project root via `git add -A`, so it's safe
 * only when no OTHER main-mode task holds uncommitted work there; otherwise the
 * commit would sweep that task's in-flight edits under the wrong message. The
 * default config (`default_run_mode: main`, `max_concurrency: 3`) runs several
 * main-mode tasks in one root, so this gate is what keeps auto-commit from
 * corrupting commit boundaries — an unsafe task is skipped and retried once the
 * root clears, never committed with foreign changes.
 */
export function isCommitIsolated(target: Task, tasks: Task[]): boolean {
  if (target.runMode !== 'main') return true;
  return !tasks.some((t) => t.id !== target.id && holdsUncommittedRootWork(t));
}

/** Inputs to {@link planAutoCommits}. */
export interface AutoCommitPlanInput {
  /** The live board tasks (reconciled from `nc:task`). */
  tasks: Task[];
  /** Whether the observer is active (loop running AND option enabled). */
  active: boolean;
  /** Whether the observer was active on the previous pass (for seed-on-activation). */
  wasActive: boolean;
  /** Task ids already committed this activation (won't be re-committed). */
  handled: ReadonlySet<string>;
}

/** The decision from {@link planAutoCommits}. */
export interface AutoCommitPlan {
  /** Tasks to fire `commit_task` for this pass. */
  commits: Task[];
  /** The handled set to carry into the next pass. */
  nextHandled: Set<string>;
  /** The active flag to carry into the next pass. */
  nextActive: boolean;
}

/**
 * Decide which verified tasks to auto-commit this pass — pure, so the branching
 * (seed-on-activation, dedupe, prune-on-re-run, shared-root isolation) is
 * unit-testable without React.
 *
 * - Inactive → commit nothing and clear `handled` (so re-activating never
 *   retroactively commits tasks verified while the option was off).
 * - Just activated → seed `handled` with the current verified-uncommitted tasks
 *   and commit nothing, so enabling the option never batch-commits a backlog.
 * - Active steady-state → prune ids whose task left `Done` (re-run) so a later
 *   re-verify re-arms, then commit each verified-uncommitted task that isn't yet
 *   handled AND whose commit is isolated ({@link isCommitIsolated}). A target that
 *   isn't currently isolated is skipped WITHOUT being marked handled, so it retries
 *   once the shared root clears.
 */
export function planAutoCommits({
  tasks,
  active,
  wasActive,
  handled,
}: AutoCommitPlanInput): AutoCommitPlan {
  if (!active) {
    return { commits: [], nextHandled: new Set(), nextActive: false };
  }

  if (!wasActive) {
    const seeded = new Set<string>();
    for (const task of tasks) {
      if (isAutoCommitTarget(task)) seeded.add(task.id);
    }
    return { commits: [], nextHandled: seeded, nextActive: true };
  }

  // Keep only handled ids whose task is still Done — a re-run (which clears
  // `verified`) or a delete drops it, re-arming auto-commit for a later re-verify.
  const stillDone = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const nextHandled = new Set([...handled].filter((id) => stillDone.has(id)));

  const commits: Task[] = [];
  for (const task of tasks) {
    if (!isAutoCommitTarget(task) || nextHandled.has(task.id)) continue;
    // Not isolated right now (another main-mode task holds uncommitted root work):
    // skip WITHOUT marking handled, so it retries once the root clears.
    if (!isCommitIsolated(task, tasks)) continue;
    nextHandled.add(task.id);
    commits.push(task);
  }
  return { commits, nextHandled, nextActive: true };
}

/** Inputs for {@link useAutoCommit}. */
export interface UseAutoCommitArgs {
  /** The live board tasks (reconciled from `nc:task`). */
  tasks: Task[];
  /** The persisted `autoCommitOnVerified` Auto Mode option. */
  enabled: boolean;
  /** Whether the autonomous loop is running (reflects `nc:loop`). */
  autoMode: boolean;
  /** The shared action guard — auto-commit runs through the same `commit:<id>` key
   *  as the manual Commit button, so the two can't double-fire one task. */
  action: ActionGuard;
  toast: ToastApi;
}

/**
 * Auto Mode option — auto-commit on verified.
 *
 * While the autonomous loop is running AND the option is enabled, fire the
 * `commit_task` IPC once for each task that transitions into the verified state,
 * so the loop commits its output as it produces it. The backend already pulls the
 * next task on its own (a finished run kicks the loop), so this observer only
 * commits — it never drives the loop. Decision logic lives in the pure
 * {@link planAutoCommits}; this hook applies the side effects and carries state.
 *
 * - Only commits when isolated ({@link isCommitIsolated}) so a shared-root
 *   (main-mode) commit can't sweep a concurrent task's edits.
 * - Shares the `commit:<id>` action guard with the manual Commit button; the
 *   backend `TaskLease` + `committed` flag are the final backstop against a double
 *   commit.
 * - At most one attempt per verified episode, so a persistent commit failure can't
 *   spin (a re-run re-arms it).
 * - `nothing to commit` is a benign skip (e.g. a worktree task whose build work was
 *   already committed pre-review) — swallowed without a toast; other failures
 *   surface once (naming the task) and are not retried.
 */
export function useAutoCommit({
  tasks,
  enabled,
  autoMode,
  action,
  toast,
}: UseAutoCommitArgs): void {
  // Task ids already attempted this activation, and whether we were active last
  // pass — both survive re-renders so the pure plan stays correct across `nc:task`
  // echoes without re-firing.
  const handledRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(false);
  const notifyError = toast.error;

  useEffect(() => {
    const { commits, nextHandled, nextActive } = planAutoCommits({
      tasks,
      active: enabled && autoMode,
      wasActive: activeRef.current,
      handled: handledRef.current,
    });
    handledRef.current = nextHandled;
    activeRef.current = nextActive;

    for (const task of commits) {
      action.guard('commit', task.id, () =>
        commitTask(task.id).catch((err: unknown) => {
          // Clean tree (worktree work already committed pre-review): benign skip.
          if (/nothing to commit/i.test(String(err))) return;
          console.error('auto commit_task failed', task.id, err);
          notifyError(`Auto-commit failed for "${task.title}"`, err);
        }),
      );
    }
  }, [tasks, enabled, autoMode, action, notifyError]);
}
