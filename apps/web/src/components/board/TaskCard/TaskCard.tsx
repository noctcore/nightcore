import { memo } from 'react';

import {
  AlertIcon,
  BoardIcon,
  BranchIcon,
  CheckIcon,
  ClockIcon,
  CommitIcon,
  EditIcon,
  IconButton,
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

import { useTaskActions } from '../actions';
import { IssueClosedChip } from '../IssueClosedChip';
import { formatCostUsd } from '../status';
import { TaskCardTerminalChip } from '../TaskCardTerminalChip';
import { TaskCardUsageChip } from '../TaskCardUsageChip';
import {
  ACTION_BASE,
  ACTION_DANGER,
  ACTION_DISABLED,
  ACTION_GHOST,
  ACTION_PRIMARY,
  CARD_BASE,
  containerClass,
  LOGS_COUNT,
  META_CHIP,
  STATUS_CHIP,
  TIMER_CHIP,
} from './TaskCard.appearance';
import { useElapsed, useTaskCardView, useTaskDraggable } from './TaskCard.hooks';
import type { TaskCardProps } from './TaskCard.types';

/** A task card showing its full anatomy: model badge + dot, elapsed timer
 *  and shimmer progress while running, cost, branch/blocked/error chips, and the
 *  per-column action set (run/cancel/logs/delete, plus commit/refine/merge per
 *  status). Pure presentational — selection and bridge actions are
 *  owned by the board.
 *
 *  Memoized: a board-wide `nc:session` delta re-renders the Board → Columns,
 *  but a card whose own props (its task object + primitive flags) are unchanged
 *  skips re-rendering. The action handlers arrive via `TaskActionsContext` (one
 *  referentially stable group — a context update, not a prop, so it cannot
 *  defeat this memo on a flush) and `logCount` is a primitive, so only the one
 *  card whose stream count changed re-renders. */
function TaskCardImpl({
  task,
  selected,
  blocked = false,
  blockedBy,
  needsApproval = false,
  logCount = 0,
  draggable = false,
  preview = false,
}: TaskCardProps) {
  const {
    onSelect,
    onRun,
    onCancel,
    onDelete,
    onApprove,
    onRefine,
    onCommit,
    onMerge,
    isActionPending,
  } = useTaskActions();
  // Model badge, run gate, blocked chip, chip visibility + pulse — derived together in
  // the card hook to keep this body lean (T13).
  const { badge, gate, depChip, showBranch, showMainChip, pulse } = useTaskCardView(
    task,
    blocked,
    blockedBy,
    needsApproval,
  );
  const running = task.status === 'in_progress';
  const verifying = task.status === 'verifying';
  const elapsed = useElapsed(task.status, task.updatedAt);
  const drag = useTaskDraggable(task.id, draggable, preview);
  const branch = task.branch;
  const mainMode = task.runMode === 'main';

  // True while a named bridge command is in flight for this task — disables the
  // matching board button and swaps its icon for a Spinner + "…ing" label, so the
  // card gives the same pending feedback the TaskDetail footer already does.
  const pending = (action: string): boolean => isActionPending?.(action, task.id) ?? false;
  const runPending = pending('run');
  const approvePending = pending('approve');
  const refinePending = pending('refine');
  const mergePending = pending('merge');
  const commitPending = pending('commit');

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
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-3xs text-muted-foreground">
            <span
              aria-hidden
              className="inline-block h-[5px] w-[5px] rounded-full"
              style={{ background: badge.dotColor }}
            />
            {badge.label}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {(running || verifying) && (
              <span className={`${TIMER_CHIP} ${running ? 'text-warning' : 'text-primary'}`}>
                <ClockIcon size={12} />
                {elapsed}
              </span>
            )}
            {task.verified && (task.status === 'done' || task.status === 'waiting_approval') && (
              <span
                aria-label="Verified"
                className="flex items-center gap-1 font-mono text-3xs-plus font-semibold text-success"
              >
                <VerifiedIcon size={12} />
                verified
              </span>
            )}
            {!running && !verifying && task.costUsd !== null && (
              <span className="font-mono text-3xs-plus tabular-nums text-muted-foreground">
                {formatCostUsd(task.costUsd)}
              </span>
            )}
          </span>
        </div>

        <div
          className="line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-foreground"
          title={task.title || 'Untitled task'}
        >
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
              <span className={META_CHIP} title={branch ?? undefined}>
                <BranchIcon size={11} />
                <span className="min-w-0 truncate">{branch}</span>
              </span>
            )}
            {showMainChip && (
              <span className={META_CHIP} title="Runs on the project directory — no worktree">
                <BoardIcon size={11} />
                <span className="min-w-0 truncate">main</span>
              </span>
            )}
            {verifying && (
              <span className={`${STATUS_CHIP} bg-primary/[0.14] text-primary`}>
                <SparkIcon size={11} />
                verifying
              </span>
            )}
            {needsApproval && (
              <span className={`${STATUS_CHIP} bg-warning/[0.14] text-warning`}>
                <AlertIcon size={11} />
                needs input
              </span>
            )}
            {task.conflict && (
              <span className={`${STATUS_CHIP} bg-destructive/[0.12] text-destructive`}>
                <AlertIcon size={11} />
                merge conflict
              </span>
            )}
            {blocked && (
              <span
                className={`${STATUS_CHIP} max-w-full bg-warning/[0.12] text-warning`}
                title={depChip.tooltip}
              >
                <LockIcon size={11} />
                <span className="min-w-0 truncate">{depChip.label}</span>
              </span>
            )}
            {task.status === 'failed' && task.error !== null && (
              <span
                className={`${STATUS_CHIP} max-w-full bg-destructive/[0.12] text-destructive`}
                title={task.error}
              >
                <AlertIcon size={11} />
                <span className="min-w-0 truncate">{task.error}</span>
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
      <div className="mt-3 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
        {task.status === 'backlog' || task.status === 'ready' ? (
          <>
            <button
              type="button"
              disabled={!gate.enabled || runPending}
              aria-busy={runPending}
              title={gate.reason ?? undefined}
              onClick={() => onRun?.(task.id)}
              className={`${ACTION_BASE} ${!gate.enabled || runPending ? ACTION_DISABLED : ACTION_PRIMARY}`}
            >
              {runPending ? <Spinner size={13} /> : blocked ? <LockIcon size={13} /> : <PlayIcon size={13} />}
              {runPending ? 'Starting…' : blocked ? 'Blocked' : 'Run'}
            </button>
            {gate.enabled && <TaskCardUsageChip />}
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
              <span className={LOGS_COUNT}>{logCount}</span>
            </button>
            <button
              type="button"
              aria-label="Cancel run"
              title="Cancel run"
              onClick={() => onCancel?.(task.id)}
              className={`${ACTION_BASE} ${ACTION_DANGER}`}
            >
              <StopIcon size={13} />
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
              onClick={() => onRefine?.(task.id, '')}
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
              disabled={!gate.enabled || runPending}
              aria-busy={runPending}
              title={gate.reason ?? undefined}
              onClick={() => onRun?.(task.id)}
              className={`${ACTION_BASE} ${!gate.enabled || runPending ? ACTION_DISABLED : ACTION_PRIMARY}`}
            >
              {runPending ? <Spinner size={13} /> : <RetryIcon size={13} />}
              {runPending ? 'Starting…' : 'Retry'}
            </button>
            {gate.enabled && <TaskCardUsageChip />}
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
        <TaskCardTerminalChip taskId={task.id} />
        <IssueClosedChip task={task} />
        <IconButton
          label="Delete task"
          onClick={() => onDelete?.(task.id)}
          className="hover:bg-destructive/10 hover:text-destructive"
        >
          <TrashIcon size={13} />
        </IconButton>
      </div>
    </div>
  );
}

export const TaskCard = memo(TaskCardImpl);
