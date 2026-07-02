/** Presentational sub-parts for the WorktreeSwitcher: the per-tab button. */
import { BoardIcon, BranchIcon } from '@/components/ui';
import { rovingKeydown } from '@/lib/roving-keydown';

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
      tabIndex={selected ? 0 : -1}
      onKeyDown={rovingKeydown}
      onClick={onSelect}
      title={
        isMain
          ? 'Tasks running on the project directory'
          : `Worktree ${tab.branch}${
              tab.dirty
                ? ` · ${tab.changedFiles > 0 ? `${tab.changedFiles} changed` : 'uncommitted changes'}`
                : ''
            }${tab.aheadOfBase > 0 ? ` · ↑${tab.aheadOfBase}` : ''}${
              tab.behindOfBase > 0 ? ` · ↓${tab.behindOfBase}` : ''
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
        <span
          className="text-[10px] font-semibold tabular-nums text-warning"
          aria-label={
            tab.changedFiles > 0 ? `${tab.changedFiles} uncommitted files` : 'Uncommitted changes'
          }
        >
          ●{tab.changedFiles > 0 ? tab.changedFiles : ''}
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

      {tab.behindOfBase > 0 && (
        <span
          className="text-[10px] font-semibold tabular-nums text-warning"
          aria-label={`${tab.behindOfBase} commits behind base`}
        >
          ↓{tab.behindOfBase}
        </span>
      )}
    </button>
  );
}
