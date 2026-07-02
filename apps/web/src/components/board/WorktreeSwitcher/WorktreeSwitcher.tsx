import { LayersIcon } from '@/components/ui';

import { useWorktreeTabs } from './WorktreeSwitcher.hooks';
import { WorktreeTabButton } from './WorktreeSwitcher.parts';
import type { WorktreeSwitcherProps } from './WorktreeSwitcher.types';

/** The worktree switcher: a segment bar above the board with a Main
 *  tab plus one tab per live worktree. Selecting a tab sets the active worktree
 *  (lifted to the shell) and filters the board to that worktree's tasks. The tab
 *  list is derived in `useWorktreeTabs`, selection is owned by the caller.
 *  Renders nothing when only the Main tab exists. */
export function WorktreeSwitcher({ tasks, worktrees, active, onSelect }: WorktreeSwitcherProps) {
  const tabs = useWorktreeTabs(tasks, worktrees);

  if (tabs.length <= 1) return null;

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
      {tabs.map((tab) => (
        <WorktreeTabButton
          key={tab.branch ?? '__main__'}
          tab={tab}
          selected={active === tab.branch}
          onSelect={() => onSelect(tab.branch)}
        />
      ))}
    </div>
  );
}
