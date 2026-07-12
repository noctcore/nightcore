/** The TaskDetail drawer header — status pill, cost, title, provenance chip, and
 *  the close button. Split out of the memoized chrome; takes a small prop surface
 *  of already-derived scalars so it re-renders only when they change. */
import { CloseIcon, IconButton } from '@/components/ui';
import { sourceRefLabel } from '@/lib/source-ref';

import { formatCostUsd, STATUS_LABEL, STATUS_TEXT } from '../status';
import { TaskStatusDot } from '../TaskStatusDot';
import type { TaskDetailHeaderProps } from './TaskDetail.types';

export function TaskDetailHeader({ task, cost, onClose, onOpenSourceRef }: TaskDetailHeaderProps) {
  // Provenance chip: where a converted task came from (scan finding/reading/proposal).
  const provenance = sourceRefLabel(task.sourceRef);

  return (
    <header className="flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <TaskStatusDot status={task.status} glow />
          <span
            className={`font-mono text-2xs font-semibold uppercase tracking-[0.08em] ${
              task.status === 'done' && !task.verified
                ? 'text-muted-foreground'
                : STATUS_TEXT[task.status]
            }`}
          >
            {task.status === 'done' && task.verified ? 'Verified' : STATUS_LABEL[task.status]}
          </span>
          {cost !== null && (
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              · {formatCostUsd(cost)}
            </span>
          )}
        </div>
        <h2 className="mt-2 truncate text-base font-semibold text-foreground">
          {task.title || 'Untitled task'}
        </h2>
        {provenance !== null && task.sourceRef !== null && (
          onOpenSourceRef !== undefined ? (
            <button
              type="button"
              onClick={() => onOpenSourceRef(task.sourceRef!)}
              title="Open the originating scan item"
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              From {provenance} ↗
            </button>
          ) : (
            <span className="mt-1.5 inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              From {provenance}
            </span>
          )
        )}
      </div>
      <IconButton label="Close detail panel" onClick={onClose}>
        <CloseIcon size={16} />
      </IconButton>
    </header>
  );
}
