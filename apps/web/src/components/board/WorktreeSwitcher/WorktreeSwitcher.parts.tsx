/** Presentational sub-parts for the WorktreeSwitcher: the per-tab button. */
import { BoardIcon, BranchIcon } from '@/components/ui';
import type { WorktreeTab } from './WorktreeSwitcher.types';

/** Props for a single worktree tab button. */
interface WorktreeTabButtonProps {
  tab: WorktreeTab;
  selected: boolean;
  onSelect: () => void;
}

/** A single switcher tab: the Main or branch
 *  label with a task-count chip and a monitor cluster — a pulsing running dot, a
 *  dirty marker, and an ahead-of-base count. */
export function WorktreeTabButton({ tab, selected, onSelect }: WorktreeTabButtonProps) {
  const isMain = tab.branch === null;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      title={
        isMain
          ? 'Tasks running on the project directory'
          : `Worktree ${tab.branch}${tab.dirty ? ' · uncommitted changes' : ''}${
              tab.aheadOfBase > 0 ? ` · ${tab.aheadOfBase} ahead` : ''
            }`
      }
      className={`flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 font-mono text-[12px] transition-colors ${
        selected
          ? 'border-primary/60 bg-primary/[0.12] text-foreground'
          : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20 hover:text-foreground'
      }`}
    >
      <span className={selected ? 'text-primary' : 'text-muted-foreground'}>
        {isMain ? <BoardIcon size={12} /> : <BranchIcon size={12} />}
      </span>
      <span className="max-w-[180px] truncate">{tab.label}</span>

      {tab.taskCount > 0 && (
        <span className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded bg-white/[0.07] px-1 text-[10px] tabular-nums text-muted-foreground">
          {tab.taskCount}
        </span>
      )}

      {tab.runningCount > 0 && (
        <span
          className="flex items-center gap-1 text-[10px] font-semibold text-warning"
          aria-label={`${tab.runningCount} running`}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
          {tab.runningCount}
        </span>
      )}

      {tab.dirty && (
        <span className="text-[10px] font-semibold text-warning" aria-label="Uncommitted changes">
          ●
        </span>
      )}

      {tab.aheadOfBase > 0 && (
        <span
          className="text-[10px] font-semibold tabular-nums text-success"
          aria-label={`${tab.aheadOfBase} commits ahead of base`}
        >
          ↑{tab.aheadOfBase}
        </span>
      )}
    </button>
  );
}
