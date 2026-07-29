/** Presentational sub-parts of the task card, lifted out of `TaskCard.tsx` (the
 *  sanctioned `.parts.tsx` overflow pattern) so the entry file stays under the size
 *  caps: the meta/status chip row and the multi-select toggle. State + derivation stay
 *  in `TaskCard.hooks.ts`; these take already-derived scalars. */
import {
  AlertIcon,
  BoardIcon,
  BranchIcon,
  CheckIcon,
  LockIcon,
  SparkIcon,
} from '@/components/ui';

import { META_CHIP, STATUS_CHIP } from './TaskCard.appearance';
import type { TaskCardChipsProps, TaskSelectToggleProps } from './TaskCard.types';

/** The card's chip row: run-order position, branch / main-mode, verifying,
 *  needs-input, merge conflict, blocked-on-deps, and the failure reason. Rendered only
 *  when at least one chip applies (the row owns its own emptiness check so the card
 *  body doesn't repeat the condition). */
export function TaskCardChips({ task, view, blocked, needsApproval }: TaskCardChipsProps) {
  const { order, depChip, showBranch, showMainChip } = view;
  const verifying = task.status === 'verifying';
  const failed = task.status === 'failed' && task.error !== null;
  const any =
    order !== null ||
    showBranch ||
    showMainChip ||
    blocked ||
    needsApproval ||
    verifying ||
    task.conflict ||
    failed;
  if (!any) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {/* Run order (#402): the position the auto-loop will pick this task up at. The
          columns sort newest-updated-first, so without this the visual order silently
          misleads on any dependency chain. `startsNow` = the next tick launches it. */}
      {order !== null && (
        <span
          className={`${STATUS_CHIP} ${
            order.startsNow
              ? 'bg-primary/[0.14] text-primary'
              : 'bg-white/[0.05] text-muted-foreground'
          }`}
          title={order.tooltip}
        >
          {order.label}
        </span>
      )}
      {showBranch && (
        <span className={META_CHIP} title={task.branch ?? undefined}>
          <BranchIcon size={11} />
          <span className="min-w-0 truncate">{task.branch}</span>
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
      {failed && (
        <span
          className={`${STATUS_CHIP} max-w-full bg-destructive/[0.12] text-destructive`}
          title={task.error ?? undefined}
        >
          <AlertIcon size={11} />
          <span className="min-w-0 truncate">{task.error}</span>
        </span>
      )}
    </div>
  );
}

/** The card's multi-select toggle (#402). A real `role="checkbox"` button (keyboard +
 *  screen-reader accessible) rendered in the card's ACTION row — outside the card-body
 *  `<button>`, so it never nests interactive controls, and inside the row that already
 *  stops click propagation, so toggling selection can't also open the task.
 *
 *  Drag-safe: the @dnd-kit pointer sensor has a 6px activation distance, so a click on
 *  this toggle never starts a drag (the same contract the run/commit buttons rely on). */
export function TaskSelectToggle({ title, selected, onToggle }: TaskSelectToggleProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`Select task ${title}`}
      title={selected ? 'Remove from selection' : 'Add to selection'}
      onClick={onToggle}
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-white/[0.02] text-transparent hover:border-white/25 hover:text-muted-foreground'
      }`}
    >
      <CheckIcon size={12} />
    </button>
  );
}
