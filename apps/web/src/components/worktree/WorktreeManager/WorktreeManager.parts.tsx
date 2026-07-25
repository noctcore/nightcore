/** Presentational sub-parts for WorktreeManager: a tinted status chip and a
 *  worktree row with its badge cluster + per-row actions. */
import {
  BranchIcon,
  Button,
  ExternalLinkIcon,
  FolderIcon,
  GithubIcon,
  LogsIcon,
  MoveIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/ui';

import type { WorktreeChip, WorktreeChipTone, WorktreeRowView } from './WorktreeManager.types';

/** Tinted classes per chip tone, mirroring the codebase's semantic status
 *  tokens (amber `warning`, emerald `success`, red `destructive`). */
const CHIP_TONES: Record<WorktreeChipTone, string> = {
  warning: 'border-warning/40 bg-warning/[0.12] text-warning',
  success: 'border-success/40 bg-success/[0.12] text-success',
  danger: 'border-destructive/40 bg-destructive/[0.12] text-destructive',
};

/** A small tinted status chip — changed / ahead / behind / diverged. */
function StatusChip({ chip }: { chip: WorktreeChip }) {
  return (
    <span
      aria-label={chip.ariaLabel}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-3xs font-medium tabular-nums ${CHIP_TONES[chip.tone]}`}
    >
      {chip.dot === true && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {chip.label}
    </span>
  );
}

/** Props for a single worktree row. */
interface WorktreeRowProps {
  view: WorktreeRowView;
  onOpenPr?: (url: string) => void;
  onViewDiff: (taskId: string) => void;
  onPreviewMerge: (taskId: string) => void;
  onDiscard: (taskId: string) => void;
  onOpenTerminal?: (path: string) => void;
  onReveal?: (taskId: string) => void;
  onOpenEditor?: (taskId: string) => void;
}

/** One worktree: the branch (monospace) + optional task title, a status-badge
 *  cluster (plus a passive `PR #n` chip when the task carries a PR — a static
 *  link-out, NO live status fetching per row), and View diff / Merge / Discard
 *  actions keyed on the primary task. Actions disable when the worktree owns
 *  no task (`primaryTaskId === null`). */
export function WorktreeRow({
  view,
  onOpenPr,
  onViewDiff,
  onPreviewMerge,
  onDiscard,
  onOpenTerminal,
  onReveal,
  onOpenEditor,
}: WorktreeRowProps) {
  const taskId = view.primaryTaskId;
  const disabled = taskId === null;

  return (
    <li className="flex items-start gap-3 rounded-nc border border-border bg-white/[0.02] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <BranchIcon size={13} className="shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs-flat text-foreground">{view.branch}</span>
          {view.pr !== null && onOpenPr !== undefined && (
            <button
              type="button"
              onClick={() => onOpenPr(view.pr!.url)}
              title="Open the pull request in your browser"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <GithubIcon size={11} />
              {view.pr.number !== null ? `PR #${view.pr.number}` : 'PR'}
              <ExternalLinkIcon size={11} />
            </button>
          )}
        </div>
        {view.title !== undefined && (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">{view.title}</p>
        )}
        {view.chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {view.chips.map((chip) => (
              <StatusChip key={chip.key} chip={chip} />
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {onOpenTerminal !== undefined && (
          <Button
            variant="secondary"
            onClick={() => onOpenTerminal(view.path)}
            title="Open a terminal in this worktree"
          >
            <TerminalIcon size={13} />
            Terminal
          </Button>
        )}
        {onOpenEditor !== undefined && (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => taskId !== null && onOpenEditor(taskId)}
            title="Open the worktree in your editor"
          >
            <ExternalLinkIcon size={13} />
            Editor
          </Button>
        )}
        {onReveal !== undefined && (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => taskId !== null && onReveal(taskId)}
            title="Reveal the worktree in Finder"
          >
            <FolderIcon size={13} />
            Reveal
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => taskId !== null && onViewDiff(taskId)}
        >
          <LogsIcon size={13} />
          Diff
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => taskId !== null && onPreviewMerge(taskId)}
        >
          <MoveIcon size={13} />
          Merge
        </Button>
        <Button
          variant="danger"
          disabled={disabled}
          onClick={() => taskId !== null && onDiscard(taskId)}
        >
          <TrashIcon size={13} />
          Discard
        </Button>
      </div>
    </li>
  );
}
