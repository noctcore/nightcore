import { memo } from 'react';

import {
  AlertIcon,
  BoardIcon,
  BranchIcon,
  CheckIcon,
  ClockIcon,
  CommitIcon,
  EditIcon,
  LockIcon,
  LogsIcon,
  PlayIcon,
  RefineIcon,
  RetryIcon,
  SparkIcon,
  Spinner,
  StopIcon,
  TrashIcon,
  VerifiedIcon,
} from '@/components/ui';

import { formatCost, modelDisplayName, modelDotColor } from '../status';
import { useElapsed, useTaskDraggable } from './TaskCard.hooks';
import type { TaskCardProps } from './TaskCard.types';

const CARD_BASE =
  'nc-board-card group relative w-full rounded-xl border bg-card p-3.5 text-left transition-[border-color,box-shadow,background]';

/** Container classes per status, always using the glow treatment. The
 *  running-accent glow stays; a verifying task carries the primary-tinted
 *  reviewer glow. */
function containerClass(status: string, running: boolean, selected: boolean): string {
  if (running) {
    return 'border-warning/55 shadow-[0_0_0_1px_oklch(80%_.14_75_/_.3),0_10px_34px_-8px_oklch(80%_.14_75_/_.45)]';
  }
  if (status === 'verifying') {
    return 'border-primary/55 shadow-[0_0_0_1px_oklch(74%_.13_280_/_.3),0_10px_34px_-8px_oklch(74%_.13_280_/_.45)]';
  }
  if (status === 'failed') {
    return 'border-destructive/45 shadow-[0_0_0_1px_oklch(66%_.2_22_/_.2),0_8px_26px_-14px_oklch(66%_.2_22_/_.4)]';
  }
  if (status === 'done') {
    return 'border-border border-l-2 border-l-success/50 shadow-[0_0_0_1px_oklch(76%_.15_152_/_.16),0_8px_26px_-14px_oklch(76%_.15_152_/_.4)]';
  }
  const base = selected ? 'border-primary/60' : 'border-border hover:border-white/20';
  return `${base} shadow-[0_8px_22px_-14px_oklch(0%_0_0_/_.9)]`;
}

const ACTION_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-[filter,background] disabled:cursor-not-allowed';
const ACTION_PRIMARY = 'flex-1 bg-primary text-primary-foreground hover:brightness-110';
const ACTION_GHOST = 'flex-1 border border-border text-foreground hover:bg-white/[0.05]';
const ACTION_DANGER =
  'bg-destructive/[0.14] text-destructive border border-destructive/30 hover:brightness-110';
const ACTION_DISABLED = 'flex-1 border border-border bg-white/[0.04] text-muted-foreground';

/** A task card showing its full anatomy: model badge + dot, elapsed timer
 *  and shimmer progress while running, cost, branch/blocked/error chips, and the
 *  per-column action set (run/cancel/logs/delete, plus commit/refine/merge per
 *  status). Pure presentational — selection and bridge actions are
 *  owned by the board.
 *
 *  Memoized: a board-wide `nc:session` delta re-renders the Board → Columns,
 *  but a card whose own props (its task object + primitive flags) are unchanged
 *  skips re-rendering. The handler props are stable `useCallback`s and `logCount`
 *  is a primitive, so only the one card whose stream count changed re-renders. */
function TaskCardImpl({
  task,
  selected,
  blocked = false,
  needsApproval = false,
  logCount = 0,
  draggable = false,
  preview = false,
  onSelect,
  onRun,
  onCancel,
  onDelete,
  onApprove,
  onRefine,
  onCommit,
  onMerge,
  isActionPending,
}: TaskCardProps) {
  const running = task.status === 'in_progress';
  const verifying = task.status === 'verifying';
  const elapsed = useElapsed(task.updatedAt, running || verifying);
  const drag = useTaskDraggable(task.id, draggable, preview);
  const branch = task.branch;
  const mainMode = task.runMode === 'main';
  const settled =
    running ||
    verifying ||
    task.status === 'waiting_approval' ||
    task.status === 'done' ||
    task.status === 'failed';
  const showBranch = branch !== null && settled;
  // A main-mode task edits the project tree in place — surface a "main" chip
  // (it has no branch) whenever a worktree task would show its branch chip.
  const showMainChip = mainMode && settled;

  // True while a named bridge command is in flight for this task — disables the
  // matching board button and swaps its icon for a Spinner + "…ing" label, so the
  // card gives the same pending feedback the TaskDetail footer already does.
  const pending = (action: string): boolean => isActionPending?.(action, task.id) ?? false;
  const runPending = pending('run');
  const approvePending = pending('approve');
  const refinePending = pending('refine');
  const mergePending = pending('merge');
  const commitPending = pending('commit');

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const pulse = needsApproval
    ? 'animate-pulse ring-1 ring-warning/60'
    : verifying
      ? 'animate-pulse ring-1 ring-primary/50'
      : '';

  return (
    <div
      ref={drag.setNodeRef}
      className={`${CARD_BASE} ${containerClass(task.status, running, selected)} ${pulse} ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${drag.isDragging ? 'opacity-40' : ''}`}
      {...(draggable ? drag.attributes : {})}
      {...(draggable ? drag.listeners : {})}
    >
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        className="block w-full text-left"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            <span
              aria-hidden
              className="inline-block h-[5px] w-[5px] rounded-full"
              style={{ background: modelDotColor(task.model) }}
            />
            {modelDisplayName(task.model)}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {running && (
              <span className="flex items-center gap-1 font-mono text-[10.5px] font-semibold tabular-nums text-warning">
                <ClockIcon size={12} />
                {elapsed}
              </span>
            )}
            {verifying && (
              <span className="flex items-center gap-1 font-mono text-[10.5px] font-semibold tabular-nums text-primary">
                <ClockIcon size={12} />
                {elapsed}
              </span>
            )}
            {task.verified && (task.status === 'done' || task.status === 'waiting_approval') && (
              <span
                aria-label="Verified"
                className="flex items-center gap-1 font-mono text-[10.5px] font-semibold text-success"
              >
                <VerifiedIcon size={12} />
                verified
              </span>
            )}
            {!running && !verifying && task.costUsd !== null && (
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {formatCost(task.costUsd)}
              </span>
            )}
          </span>
        </div>

        <div className="line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-foreground">
          {task.title || 'Untitled task'}
        </div>
        {task.description.trim().length > 0 && (
          <div className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {task.description}
          </div>
        )}

        {(showBranch ||
          showMainChip ||
          blocked ||
          needsApproval ||
          verifying ||
          task.conflict ||
          task.status === 'failed') && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {showBranch && (
              <span className="flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
                <BranchIcon size={11} />
                {branch}
              </span>
            )}
            {showMainChip && (
              <span
                className="flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                title="Runs on the project directory — no worktree"
              >
                <BoardIcon size={11} />
                main
              </span>
            )}
            {verifying && (
              <span className="flex items-center gap-1 rounded-md bg-primary/[0.14] px-1.5 py-0.5 font-mono text-[9.5px] text-primary">
                <SparkIcon size={11} />
                reviewing
              </span>
            )}
            {needsApproval && (
              <span className="flex items-center gap-1 rounded-md bg-warning/[0.14] px-1.5 py-0.5 font-mono text-[9.5px] text-warning">
                <AlertIcon size={11} />
                needs approval
              </span>
            )}
            {task.conflict && (
              <span className="flex items-center gap-1 rounded-md bg-destructive/[0.12] px-1.5 py-0.5 font-mono text-[9.5px] text-destructive">
                <AlertIcon size={11} />
                merge conflict
              </span>
            )}
            {blocked && (
              <span className="flex items-center gap-1 rounded-md bg-[oklch(74%_.13_60_/_.12)] px-1.5 py-0.5 font-mono text-[9.5px] text-[oklch(74%_.13_60)]">
                <LockIcon size={11} />
                blocked · {task.dependencies[0] ?? ''}
              </span>
            )}
            {task.status === 'failed' && task.error !== null && (
              <span className="flex max-w-full items-center gap-1 truncate rounded-md bg-destructive/[0.12] px-1.5 py-0.5 font-mono text-[9.5px] text-destructive">
                <AlertIcon size={11} />
                {task.error}
              </span>
            )}
          </div>
        )}

        {(running || verifying) && (
          <div className="relative mt-2.5 h-[2.5px] overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`absolute inset-y-0 w-[40%] bg-gradient-to-r from-transparent to-transparent ${
                verifying ? 'via-primary' : 'via-warning'
              }`}
              style={{ animation: 'nc-bar 1.3s ease-in-out infinite' }}
            />
          </div>
        )}
      </button>

      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- non-interactive wrapper; onClick only stops the real action buttons' clicks from bubbling to the card/drag container */}
      <div className="mt-3 flex gap-1.5" onClick={stop}>
        {task.status === 'backlog' || task.status === 'ready' ? (
          <>
            <button
              type="button"
              disabled={blocked || runPending}
              aria-busy={runPending}
              onClick={() => onRun?.(task.id)}
              className={`${ACTION_BASE} ${blocked || runPending ? ACTION_DISABLED : ACTION_PRIMARY}`}
            >
              {runPending ? <Spinner size={13} /> : blocked ? <LockIcon size={13} /> : <PlayIcon size={13} />}
              {runPending ? 'Starting…' : blocked ? 'Blocked' : 'Run'}
            </button>
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className={`${ACTION_BASE} ${ACTION_GHOST}`}
            >
              <EditIcon size={13} />
              Edit
            </button>
          </>
        ) : running || verifying ? (
          <>
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className={`${ACTION_BASE} ${ACTION_PRIMARY}`}
            >
              <LogsIcon size={13} />
              Logs
              <span className="rounded bg-black/20 px-1.5 font-mono text-[10px]">{logCount}</span>
            </button>
            <button
              type="button"
              aria-label="Cancel run"
              onClick={() => onCancel?.(task.id)}
              className={`${ACTION_BASE} ${ACTION_DANGER}`}
            >
              <StopIcon size={12} />
            </button>
          </>
        ) : task.status === 'waiting_approval' ? (
          <>
            <button
              type="button"
              disabled={approvePending}
              aria-busy={approvePending}
              onClick={() => onApprove?.(task.id)}
              className={`${ACTION_BASE} ${approvePending ? ACTION_DISABLED : ACTION_PRIMARY}`}
            >
              {approvePending ? <Spinner size={13} /> : <CheckIcon size={13} />}
              {approvePending ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={refinePending}
              aria-busy={refinePending}
              onClick={() => onRefine?.(task.id)}
              className={`${ACTION_BASE} ${refinePending ? ACTION_DISABLED : ACTION_GHOST}`}
            >
              {refinePending ? <Spinner size={13} /> : <RefineIcon size={13} />}
              {refinePending ? 'Refining…' : 'Refine'}
            </button>
          </>
        ) : task.status === 'done' ? (
          <>
            {task.merged ? (
              <button
                type="button"
                disabled
                title="Branch merged into the base"
                className={`${ACTION_BASE} ${ACTION_DISABLED}`}
              >
                <BranchIcon size={13} />
                Merged
              </button>
            ) : task.committed && mainMode ? (
              <button
                type="button"
                disabled
                title="Main-mode tasks edit the project directly — nothing to merge"
                className={`${ACTION_BASE} ${ACTION_DISABLED}`}
              >
                <CheckIcon size={13} />
                Committed
              </button>
            ) : task.committed ? (
              <button
                type="button"
                disabled={!task.verified || mergePending}
                aria-busy={mergePending}
                title={
                  task.verified
                    ? undefined
                    : 'Open the task to run the readiness gauntlet before merging'
                }
                onClick={() => onMerge?.(task.id)}
                className={`${ACTION_BASE} ${task.verified && !mergePending ? ACTION_PRIMARY : ACTION_DISABLED}`}
              >
                {mergePending ? <Spinner size={13} /> : <BranchIcon size={13} />}
                {mergePending ? 'Merging…' : 'Merge'}
              </button>
            ) : (
              <button
                type="button"
                disabled={commitPending}
                aria-busy={commitPending}
                onClick={() => onCommit?.(task.id)}
                className={`${ACTION_BASE} ${commitPending ? ACTION_DISABLED : ACTION_PRIMARY}`}
              >
                {commitPending ? <Spinner size={13} /> : <CommitIcon size={13} />}
                {commitPending ? 'Committing…' : 'Commit'}
              </button>
            )}
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className={`${ACTION_BASE} ${ACTION_GHOST}`}
            >
              <LogsIcon size={13} />
              Logs
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={runPending}
              aria-busy={runPending}
              onClick={() => onRun?.(task.id)}
              className={`${ACTION_BASE} ${runPending ? ACTION_DISABLED : ACTION_PRIMARY}`}
            >
              {runPending ? <Spinner size={13} /> : <RetryIcon size={13} />}
              {runPending ? 'Starting…' : 'Retry'}
            </button>
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              className={`${ACTION_BASE} ${ACTION_GHOST}`}
            >
              <LogsIcon size={13} />
              Logs
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Delete task"
          onClick={() => onDelete?.(task.id)}
          className="flex items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
        >
          <TrashIcon size={13} />
        </button>
      </div>
    </div>
  );
}

export const TaskCard = memo(TaskCardImpl);
