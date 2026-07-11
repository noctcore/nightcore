/** The TaskDetail drawer footer — the per-status action bar (plan-approval gate,
 *  review-verdict resolve, Done-column commit/merge/PR, and the run/cancel/delete
 *  controls). Split out of the memoized chrome; it reads the grouped board actions
 *  from `TaskActionsContext` and derives its own button-eligibility scalars. */
import {
  BranchIcon,
  Button,
  CheckIcon,
  CommitIcon,
  GithubIcon,
  LayersIcon,
  Spinner,
} from '@/components/ui';

import { useTaskActions } from '../actions';
import { canRunTask, useRunGate } from '../run-gating';
import { canCreatePr, canMerge, createPrBlockedReason, prChipLabel } from './TaskDetail.hooks';
import type { TaskDetailFooterProps } from './TaskDetail.types';

export function TaskDetailFooter({
  task,
  gauntlet,
  prSupport,
  prStatusView,
  planParked,
  reviewParked,
  isDoneColumn,
  isRunning,
  pending,
}: TaskDetailFooterProps) {
  const actions = useTaskActions();
  const { slotsFree } = useRunGate();
  const mergeable = canMerge(task, gauntlet);
  // The SAME slot-aware gate the board card uses (T13): a non-done task can start when a
  // run slot is free, replacing the old "another task is already running" check that
  // refused whenever ANY task ran even though concurrency defaults to 3.
  const runGate = canRunTask({ blocked: false, slotsFree });
  // Duplicate (T13: re-run-with-tweaks): clone this task's prompt + config into a fresh
  // backlog task and open it for editing. Shown beside Delete on the settled branches.
  const duplicateButton =
    actions.onDuplicate !== undefined ? (
      <Button
        variant="ghost"
        onClick={() => actions.onDuplicate!(task.id)}
        title="Duplicate this task's prompt + config into a new backlog task"
      >
        <LayersIcon size={14} />
        Duplicate
      </Button>
    ) : null;
  // Freshly-fetched PR state (from the lifted status view): a PR already
  // merged ON GitHub must not arm the local Merge — the worktree branch was
  // integrated remotely, and a local merge would re-apply it against a base
  // that may already contain it. Finalize is the correct exit.
  const remoteMerged = prStatusView.status?.state === 'MERGED';
  const mainMode = task.runMode === 'main';
  // Create PR eligibility, surfaced explicitly (never a silent hide): an eligible
  // task gets the enabled button; a worktree task that is not YET eligible gets a
  // DISABLED button whose tooltip names the unmet condition; a task where a PR does
  // not apply (main-mode / merged / already published) gets neither.
  const prCreatable = canCreatePr(task, prSupport);
  const prBlockedReason = createPrBlockedReason(task, prSupport);

  return (
    <footer className="flex items-center gap-2 border-t border-border bg-card px-4 py-3">
      {planParked ? (
        <>
          {/* The Approve / Refine / Reject controls live in the PlanReview panel above
              (colocated with the plan + refine-feedback field, mirroring the
              review-verdict pattern) — the footer only points to them. */}
          <span className="flex-1 text-xs text-muted-foreground">
            Review the plan above.
          </span>
          <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
            Delete
          </Button>
        </>
      ) : reviewParked ? (
        <>
          <span className="flex-1 text-xs text-muted-foreground">
            Resolve the reviewer verdict above.
          </span>
          <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
            Delete
          </Button>
        </>
      ) : isDoneColumn ? (
        <>
          {task.merged ? (
            <Button disabled title="Branch merged into the base">
              <BranchIcon size={14} />
              Merged
            </Button>
          ) : task.committed && mainMode ? (
            <Button
              disabled
              title="Main-mode tasks edit the project directly — nothing to merge"
            >
              <CheckIcon size={14} />
              Committed
            </Button>
          ) : task.committed ? (
            <Button
              onClick={() => actions.onMerge?.(task.id)}
              disabled={!mergeable || remoteMerged || pending('merge')}
              aria-busy={pending('merge')}
              title={
                remoteMerged
                  ? 'Merged on GitHub — use Finalize'
                  : mergeable
                    ? undefined
                    : 'Merge needs a verified task and a passing gauntlet — run the checks first'
              }
            >
              {pending('merge') ? <Spinner /> : <BranchIcon size={14} />}
              {pending('merge') ? 'Merging…' : 'Merge'}
            </Button>
          ) : (
            <Button
              onClick={() => actions.onCommit?.(task.id)}
              disabled={pending('commit')}
              aria-busy={pending('commit')}
            >
              {pending('commit') ? <Spinner /> : <CommitIcon size={14} />}
              {pending('commit') ? 'Committing…' : 'Commit'}
            </Button>
          )}
          {/* The PR terminal action beside Merge: a `PR #<n>` chip linking out
              once one exists, else Create PR when the full eligibility contract
              holds (done + verified + committed + worktree + !merged + a green
              `pr_support` probe). When a worktree task isn't yet eligible the
              button stays visible but DISABLED, its tooltip naming the unmet
              condition — so the user can always see why a PR can't be opened
              rather than the button silently vanishing. */}
          {task.prUrl !== undefined ? (
            <Button
              variant="secondary"
              onClick={() => actions.onOpenPr?.(task.prUrl!)}
              title="Open the pull request in your browser"
            >
              <GithubIcon size={13} />
              {prChipLabel(task)} ↗
            </Button>
          ) : actions.onCreatePr !== undefined && (prCreatable || prBlockedReason !== null) ? (
            <Button
              variant="secondary"
              onClick={() => actions.onCreatePr!(task.id)}
              disabled={!prCreatable || pending('createPr')}
              aria-busy={pending('createPr')}
              title={prCreatable ? undefined : (prBlockedReason ?? undefined)}
            >
              {pending('createPr') ? <Spinner /> : <GithubIcon size={13} />}
              Create PR
            </Button>
          ) : null}
          <span className="flex-1" />
          {duplicateButton}
          <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
            Delete
          </Button>
        </>
      ) : (
        <>
          {isRunning || task.status === 'verifying' ? (
            <Button variant="danger" onClick={() => actions.onCancel(task.id)}>
              Cancel run
            </Button>
          ) : (
            <Button
              onClick={() => actions.onRun(task.id)}
              disabled={!runGate.enabled || pending('run')}
              aria-busy={pending('run')}
              title={runGate.reason ?? undefined}
            >
              {pending('run') ? <Spinner /> : null}
              {pending('run') ? 'Starting…' : 'Run'}
            </Button>
          )}
          <span className="flex-1" />
          {!isRunning && task.status !== 'verifying' && (
            <>
              {duplicateButton}
              <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
                Delete
              </Button>
            </>
          )}
        </>
      )}
    </footer>
  );
}
