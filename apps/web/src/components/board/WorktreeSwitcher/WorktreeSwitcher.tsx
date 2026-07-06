import { LayersIcon } from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { partitionWorktreeTabs, useWorktreeTabs } from './WorktreeSwitcher.hooks';
import {
  WorktreeCollapsedSelect,
  WorktreeTabButton,
  WorktreeTabWithActions,
} from './WorktreeSwitcher.parts';
import type { WorktreeSwitcherProps } from './WorktreeSwitcher.types';

/** The worktree switcher: a segment bar above the board with a Main
 *  tab plus one tab per live worktree. Selecting a tab sets the active worktree
 *  (owned by the shell, shared via `WorktreesContext`) and filters the board to
 *  that worktree's tasks. Each worktree tab carries an actions menu (kebab)
 *  whose "Remove worktree" item discards that checkout + branch — the tab's
 *  first action affordance.
 *
 *  Overflow-aware: at or below `COLLAPSE_THRESHOLD` tabs every tab renders inline
 *  exactly as before; above it, Main stays inline and the worktrees fold into a
 *  searchable {@link WorktreeCollapsedSelect} (whose trigger reflects the active
 *  selection) so the row never wraps into clutter. The tab list is derived in
 *  `useWorktreeTabs`, the inline vs collapsed split in `partitionWorktreeTabs`.
 *  Renders nothing when only the Main tab exists. */
export function WorktreeSwitcher({ tasks }: WorktreeSwitcherProps) {
  const {
    worktrees,
    activeWorktree: active,
    setActiveWorktree: onSelect,
    removeWorktree: onRemoveWorktree,
  } = useWorktreesContext();
  const tabs = useWorktreeTabs(tasks, worktrees);

  if (tabs.length <= 1) return null;

  const { inline, collapsed } = partitionWorktreeTabs(tabs);
  // Roving-tabindex entry: a tablist must always keep exactly one `tabIndex=0` tab.
  // Normally that's the active tab, but when the active worktree has collapsed into
  // the overflow select no inline tab is selected — fall back to the first inline tab
  // (always Main) so a keyboard user can still Tab to it and return to the main board.
  const activeIsInline = inline.some((tab) => tab.branch === active);

  return (
    <div
      role="tablist"
      aria-label="Worktree"
      className="flex flex-wrap items-center gap-2 border-b border-border px-[22px] py-2.5"
    >
      <span className="mr-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <LayersIcon size={12} />
        Worktree
      </span>
      {inline.map((tab, index) => {
        const rovingEntry = activeIsInline ? tab.branch === active : index === 0;
        return tab.branch === null ? (
          <WorktreeTabButton
            key="__main__"
            tab={tab}
            selected={active === null}
            rovingEntry={rovingEntry}
            onSelect={() => onSelect(null)}
          />
        ) : (
          <WorktreeTabWithActions
            key={tab.branch}
            tab={tab}
            selected={active === tab.branch}
            rovingEntry={rovingEntry}
            onSelect={() => onSelect(tab.branch)}
            onRemove={onRemoveWorktree}
          />
        );
      })}
      {collapsed.length > 0 && (
        <WorktreeCollapsedSelect tabs={collapsed} active={active} onSelect={onSelect} />
      )}
    </div>
  );
}
