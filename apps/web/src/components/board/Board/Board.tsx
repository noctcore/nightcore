import { memo } from 'react';

import { AlertIcon, BoltIcon, Button, CloseIcon } from '@/components/ui';

import { BoardDnd } from '../BoardDnd';
import { BoardHeader } from '../BoardHeader';
import { useBoardChrome } from '../chrome';
import { Column } from '../Column';
import { formatResetClock, providerDisplay } from '../usage-hot';
import { WorktreeSwitcher } from '../WorktreeSwitcher';
import { useBoardAppearance } from './Board.appearance.hooks';
import { useBoardView, useBreakerBanner, useUsagePauseBanner } from './Board.hooks';
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
  const { appearanceOverride, backgroundVersion, breaker, onResume, usagePause } =
    useBoardChrome();
  const { search, setSearch, columns, clearHandlers, dependencyChipsById } = useBoardView(
    tasks,
    onClearColumn,
  );
  const banner = useBreakerBanner(breaker);
  const usageBanner = useUsagePauseBanner(usagePause);
  const appearance = useBoardAppearance(projectId, appearanceOverride, backgroundVersion);
  const usageResetClock = usagePause !== null ? formatResetClock(usagePause.resetsAt) : null;

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
          <span className="min-w-0 text-xs-plus text-foreground">
            Auto Mode paused after {breaker.failureThreshold} consecutive failures.
          </span>
          <Button onClick={onResume} className="ml-auto">
            <BoltIcon size={13} />
            Resume
          </Button>
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

      {usageBanner.visible && usagePause !== null && (
        <div className="flex items-center gap-3 border-b border-warning/40 bg-warning/[0.12] px-[22px] py-2.5">
          <BoltIcon size={15} className="shrink-0 text-warning" />
          <span className="min-w-0 text-xs-plus text-foreground">
            Auto Mode paused: {providerDisplay(usagePause.provider)} {usagePause.windowLabel} at{' '}
            {Math.round(usagePause.usedPercent)}%
            {usageResetClock !== null && `, resumes ~${usageResetClock}`}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={usageBanner.dismiss}
            className="ml-auto flex shrink-0 items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
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
              clearable={def.clearable}
              selectedId={selectedId}
              blockedIds={blockedIds}
              dependencyChipsById={dependencyChipsById}
              promptIds={promptIds}
              logCounts={logCounts}
              dropStatus={def.statuses[0]}
              emptyText={
                search.trim() !== '' ? (
                  'No matches'
                ) : def.key === 'backlog' ? (
                  <button
                    type="button"
                    onClick={onNewTask}
                    className="w-full rounded-[11px] border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/[0.04] hover:text-foreground"
                  >
                    {EMPTY_TEXT.backlog}
                  </button>
                ) : (
                  EMPTY_TEXT[def.key]
                )
              }
              onClear={clearHandlers[def.key]}
            />
          ))}
        </div>
      </BoardDnd>
    </div>
  );
}

export const Board = memo(BoardImpl);
