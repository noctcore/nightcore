import { memo } from 'react';

import { AlertIcon, BoltIcon, CloseIcon } from '@/components/ui';

import { BoardDnd } from '../BoardDnd';
import { BoardHeader } from '../BoardHeader';
import { useBoardChrome } from '../chrome';
import { Column } from '../Column';
import { WorktreeSwitcher } from '../WorktreeSwitcher';
import { useBoardAppearance } from './Board.appearance.hooks';
import { useBoardView, useBreakerBanner } from './Board.hooks';
import type { BoardProps } from './Board.types';

const EMPTY_TEXT: Record<string, string> = {
  backlog: 'Add a task to begin',
  in_progress: 'Nothing running',
  verifying: 'Nothing under review',
  waiting_approval: 'Nothing awaiting approval',
  done: 'No verified tasks yet',
  failed: 'No failures',
};

/** The Kanban board: the `BoardHeader` band (title, toolbar, search) over the
 *  five columns, plus a circuit-breaker Resume banner when the autonomous loop
 *  has paused after consecutive failures. Search lives in the board's view hook;
 *  the header/banner chrome (appearance + auto-loop) arrives via
 *  `BoardChromeContext`, the worktree cluster via `WorktreesContext`, and the
 *  per-card actions via `TaskActionsContext` (consumed by `TaskCard`).
 *
 *  Memoized (perf): the shell re-renders AppShell on every coalesced `nc:session`
 *  flush, but the Board's props are referentially stable (the `on*` handlers are
 *  `useCallback`s in `useAppShell`, and `logCounts` is identity-stabilized on the
 *  tool-count values) and all three context values are shell-memoized low-churn
 *  groups — so the board only re-renders when its tasks/selection/loop state
 *  actually change, not on every stream delta. */
function BoardImpl({
  tasks,
  projectId,
  projectName,
  projectPath,
  projectBranch,
  selectedId,
  logCounts,
  blockedIds,
  promptIds,
  onNewTask,
  onMoveTask,
  onClearColumn,
}: BoardProps) {
  // The appearance knobs style the whole board surface (this container) while
  // the header's Background panel edits them; the breaker cluster drives the
  // banner below the switcher. Both ride the low-churn chrome context.
  const { appearanceOverride, backgroundVersion, breaker, onResume } = useBoardChrome();
  const { search, setSearch, columns, clearHandlers } = useBoardView(tasks, onClearColumn);
  const banner = useBreakerBanner(breaker);
  const appearance = useBoardAppearance(projectId, appearanceOverride, backgroundVersion);

  return (
    <div
      className="nc-board-appearance flex h-full min-h-0 flex-col"
      style={appearance.view.style}
      {...appearance.view.dataAttrs}
    >
      {appearance.backgroundUrl !== null && (
        <div
          aria-hidden
          className="nc-board-appearance__bg"
          style={{ backgroundImage: `url("${appearance.backgroundUrl}")` }}
        />
      )}
      <BoardHeader
        taskCount={tasks.length}
        projectName={projectName}
        projectPath={projectPath}
        projectBranch={projectBranch}
        search={search}
        onSearchChange={setSearch}
        onNewTask={onNewTask}
        appearance={appearance.appearance}
        backgroundUrl={appearance.backgroundUrl}
      />

      <WorktreeSwitcher tasks={tasks} />

      {banner.visible && breaker !== null && (
        <div className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/[0.12] px-[22px] py-2.5">
          <AlertIcon size={15} className="shrink-0 text-destructive" />
          <span className="min-w-0 text-[12.5px] text-foreground">
            Auto Mode paused after {breaker.failureThreshold} consecutive failures.
          </span>
          <button
            type="button"
            onClick={onResume}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground transition-[filter] hover:brightness-110"
          >
            <BoltIcon size={13} />
            Resume
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={banner.dismiss}
            className="flex shrink-0 items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      <BoardDnd tasks={tasks} onMoveTask={onMoveTask}>
        <div className="nc-board-columns flex flex-1 gap-3.5 overflow-x-auto overflow-y-hidden px-[22px] py-4">
          {columns.map(({ def, tasks: colTasks }) => (
            <Column
              key={def.key}
              title={def.title}
              tasks={colTasks}
              dotColor={def.dotColor}
              badge={def.badge}
              clearable={def.clearable}
              selectedId={selectedId}
              blockedIds={blockedIds}
              promptIds={promptIds}
              logCounts={logCounts}
              dropStatus={def.statuses[0]}
              emptyText={search.trim() !== '' ? 'No matches' : EMPTY_TEXT[def.key]}
              onClear={clearHandlers[def.key]}
            />
          ))}
        </div>
      </BoardDnd>
    </div>
  );
}

export const Board = memo(BoardImpl);
