/** Props + view types for the WorktreeManager component. */
import type { WorktreeInfo } from '@/lib/bridge';

/** Visual tone of a worktree status chip: amber (warning), emerald (success),
 *  or red (danger). */
export type WorktreeChipTone = 'warning' | 'success' | 'danger';

/** A single derived status chip in a worktree row's badge cluster. */
export interface WorktreeChip {
  /** Stable react key (e.g. `'changed'`, `'ahead'`). */
  key: string;
  /** Tinted tone for the chip. */
  tone: WorktreeChipTone;
  /** Visible label, e.g. `'3 changed'`, `'↑2'`, `'↓1'`, `'diverged'`. */
  label: string;
  /** Spoken label for assistive tech. */
  ariaLabel: string;
  /** Render a leading status dot (used for the diverged flag). */
  dot?: boolean;
}

/** The pull request recorded on a row's primary task — enough for the passive
 *  `PR #n` chip (design §4 parity), resolved by the parent's `prForTask`.
 *  Deliberately static: NO per-row status fetching (the no-polling rule). */
export interface WorktreePrRef {
  /** The gh-reported PR page URL (opened via the system browser). */
  url: string;
  /** The PR number, or `null` when (unexpectedly) absent — the chip degrades
   *  to a plain `PR` label. */
  number: number | null;
}

/** The derived, render-ready view of one worktree row. */
export interface WorktreeRowView {
  /** The worktree's branch (`nc/<taskId>`), shown monospace. */
  branch: string;
  /** Friendly task title when the resolver returns one. */
  title?: string;
  /** The primary owning task id (`taskIds[0]`), or `null` when the worktree owns
   *  no task — actions are disabled in that case. */
  primaryTaskId: string | null;
  /** The primary task's PR, or `null` when it has none (chip hidden). */
  pr: WorktreePrRef | null;
  /** The status-badge cluster, in display order. */
  chips: WorktreeChip[];
}

/** Props for the standalone worktree manager: the worktree list, an optional
 *  task-title resolver, a loading flag, and the three per-row action callbacks.
 *  The parent (AppShell) owns the data + dialogs; this panel is presentational
 *  and only emits actions. */
export interface WorktreeManagerProps {
  /** The project's live worktrees (from `listWorktrees`). */
  worktrees: WorktreeInfo[];
  /** Resolve a friendly title for a task id; the branch shows when it's absent. */
  titleForTask?: (taskId: string) => string | undefined;
  /** Resolve the PR recorded on a task (`task.prUrl`/`prNumber`), threaded like
   *  `titleForTask` from the tasks-owning parent; `null`/absent hides the chip. */
  prForTask?: (taskId: string) => WorktreePrRef | null;
  /** Open a PR page in the system browser (the passive `PR #n` chip's click). */
  onOpenPr?: (url: string) => void;
  /** Show a spinner instead of the list while the first read is in flight. */
  loading?: boolean;
  /** View the diff for a worktree's primary task. */
  onViewDiff: (taskId: string) => void;
  /** Preview a merge of a worktree's primary task back to base. */
  onPreviewMerge: (taskId: string) => void;
  /** Discard a worktree (and its branch) for the primary task. Destructive. */
  onDiscard: (taskId: string) => void;
}
