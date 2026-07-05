import { LayersIcon } from '@/components/ui';

import { partitionWorktreeTabs, useWorktreeTabs } from './WorktreeSwitcher.hooks';
import {
  WorktreeCollapsedSelect,
  WorktreeTabButton,
  WorktreeTabWithActions,
} from './WorktreeSwitcher.parts';
import type { WorktreeSwitcherProps } from './WorktreeSwitcher.types';

/** The worktree switcher: a segment bar above the board with a Main
 *  tab plus one tab per live worktree. Selecting a tab sets the active worktree
 *  (lifted to the shell) and filters the board to that worktree's tasks. Each
 *  worktree tab carries an actions menu (kebab) whose "Remove worktree" item
 *  discards that checkout + branch — the tab's first action affordance.
 *
 *  Overflow-aware: at or below `COLLAPSE_THRESHOLD` tabs every tab renders inline
 *  exactly as before; above it, Main stays inline and the worktrees fold into a
 *  searchable {@link WorktreeCollapsedSelect} (whose trigger reflects the active
 *  selection) so the row never wraps into clutter. The tab list is derived in
 *  `useWorktreeTabs`, the inline vs collapsed split in `partitionWorktreeTabs`;
 *  selection is owned by the caller. Renders nothing when only the Main tab exists. */
export function WorktreeSwitcher({
  tasks,
  worktrees,
  active,
  onSelect,
  onRemoveWorktree,
}: WorktreeSwitcherProps) {
  const tabs = useWorktreeTabs(tasks, worktrees);

  if (tabs.length <= 1) return null;

  const { inline, collapsed } = partitionWorktreeTabs(tabs);

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
      {inline.map((tab) =>
        tab.branch === null ? (
          <WorktreeTabButton
            key="__main__"
            tab={tab}
            selected={active === null}
            onSelect={() => onSelect(null)}
          />
        ) : (
          <WorktreeTabWithActions
            key={tab.branch}
            tab={tab}
            selected={active === tab.branch}
            onSelect={() => onSelect(tab.branch)}
            onRemove={onRemoveWorktree}
          />
        ),
      )}
      {collapsed.length > 0 && (
        <WorktreeCollapsedSelect tabs={collapsed} active={active} onSelect={onSelect} />
      )}
    </div>
  );
}
