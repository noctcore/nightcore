import {
  AgentsIcon,
  AlertIcon,
  BoltIcon,
  BranchIcon,
  CloseIcon,
  Kbd,
  PlusIcon,
  SearchIcon,
} from '@/components/ui';
import { Column } from '../Column';
import { WorktreeSwitcher } from '../WorktreeSwitcher';
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

/** The Kanban board: a header (title + count chip, project path/branch subtitle,
 *  search, the live concurrency slider + Auto Mode toggle) over the five columns,
 *  plus a circuit-breaker Resume banner when the autonomous loop has paused after
 *  consecutive failures. Search lives in the board's view hook; the loop state
 *  and bridge actions are owned by the shell and passed down. */
export function Board({
  tasks,
  projectPath,
  projectBranch,
  worktrees,
  activeWorktree,
  onSelectWorktree,
  concurrency,
  autoMode,
  breaker,
  selectedId,
  logCounts,
  blockedIds,
  promptIds,
  onSelect,
  onNewTask,
  onRun,
  onCancel,
  onDelete,
  onMoveTask,
  onClearColumn,
  onApprove,
  onRefine,
  onCommit,
  onMerge,
  onToggleAutoMode,
  onConcurrencyChange,
  onResume,
}: BoardProps) {
  const { search, setSearch, columns } = useBoardView(tasks, activeWorktree);
  const banner = useBreakerBanner(breaker);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3.5 border-b border-border px-[22px] pb-3.5 pt-[18px]">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[21px] font-semibold tracking-tight">Kanban Board</h1>
              <span className="rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {tasks.length} tasks
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
              <span className="truncate">{projectPath}</span>
              {projectBranch !== null && (
                <>
                  <span className="opacity-40">·</span>
                  <BranchIcon size={11} />
                  <span>{projectBranch}</span>
                </>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <div
              title="Max parallel runs"
              className="flex items-center gap-2.5 rounded-[9px] border border-border bg-white/[0.02] px-3 py-1.5"
            >
              <AgentsIcon size={15} className="text-muted-foreground" />
              <input
                type="range"
                aria-label="Max concurrency"
                min={1}
                max={6}
                value={concurrency}
                onChange={(e) => onConcurrencyChange(Number(e.target.value))}
                className="w-[84px] accent-primary"
              />
              <span className="w-2.5 font-mono text-xs font-semibold">{concurrency}</span>
            </div>
            <button
              type="button"
              onClick={onToggleAutoMode}
              aria-pressed={autoMode}
              title={autoMode ? 'Stop Auto Mode' : 'Start Auto Mode'}
              className={`flex items-center gap-2.5 rounded-[9px] border px-3.5 py-1.5 text-[12.5px] font-semibold text-foreground transition-colors ${
                autoMode
                  ? 'border-primary/55 bg-primary/[0.12]'
                  : 'border-border bg-white/[0.02] hover:border-white/20'
              }`}
            >
              <BoltIcon
                size={14}
                className={autoMode ? 'text-primary' : 'text-muted-foreground'}
              />
              <span>Auto Mode</span>
              <span
                className={`relative h-[17px] w-[30px] rounded-full transition-colors ${
                  autoMode ? 'bg-primary' : 'bg-white/[0.12]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-[13px] w-[13px] rounded-full bg-white transition-transform ${
                    autoMode ? 'left-[14px]' : 'left-0.5'
                  }`}
                />
              </span>
            </button>
            <button
              type="button"
              onClick={onNewTask}
              className="flex items-center gap-1.5 rounded-[9px] bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-primary-foreground transition-[filter] hover:brightness-110"
            >
              <PlusIcon size={14} />
              New task
              <Kbd>N</Kbd>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[220px] max-w-[420px] flex-1 items-center gap-2.5 rounded-[9px] border border-border bg-white/[0.02] px-3 py-2">
            <SearchIcon size={15} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks by keyword…"
              className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>

      <WorktreeSwitcher
        tasks={tasks}
        worktrees={worktrees}
        active={activeWorktree}
        onSelect={onSelectWorktree}
      />

      {banner.visible && breaker !== null && (
        <div className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/[0.12] px-[22px] py-2.5">
          <AlertIcon size={15} className="shrink-0 text-destructive" />
          <span className="text-[12.5px] text-foreground">
            Auto Mode paused after {breaker.failureThreshold} consecutive failures.
          </span>
          <button
            type="button"
            onClick={onResume}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground transition-[filter] hover:brightness-110"
          >
            <BoltIcon size={13} />
            Resume
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={banner.dismiss}
            className="flex items-center justify-center rounded-lg p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-1 gap-3.5 overflow-x-auto overflow-y-hidden px-[22px] py-4">
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
            onSelect={onSelect}
            onRun={onRun}
            onCancel={onCancel}
            onDelete={onDelete}
            onMoveTask={onMoveTask}
            onApprove={onApprove}
            onRefine={onRefine}
            onCommit={onCommit}
            onMerge={onMerge}
            onClear={() => onClearColumn(def.statuses)}
          />
        ))}
      </div>
    </div>
  );
}
