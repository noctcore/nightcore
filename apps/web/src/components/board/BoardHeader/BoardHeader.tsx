import {
  AgentsIcon,
  BoltIcon,
  BranchIcon,
  Button,
  IconButton,
  ImageIcon,
  Kbd,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  Toolbar,
} from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { AutoModeOptions } from '../AutoModeOptions';
import { BoardBackgroundPanel } from '../BoardBackgroundPanel';
import { useBoardChrome } from '../chrome';
import { ProviderConfigPanel } from '../ProviderConfigPanel';
import { useBoardBackgroundPanel, useInspector } from './BoardHeader.hooks';
import type { BoardHeaderProps } from './BoardHeader.types';

/** The board's header band: title + count chip, project path/branch subtitle,
 *  the toolbar (live concurrency slider, Auto Mode toggle + options, refresh,
 *  background settings, provider inspector, New task), and the search row — plus
 *  the two fixed-overlay sheets those toolbar buttons open (`ProviderConfigPanel`
 *  and `BoardBackgroundPanel`).
 *
 *  The appearance + auto-loop cluster arrives via `BoardChromeContext` (a
 *  low-churn value: it changes only on loop events / settings writes, never on a
 *  per-frame stream flush) and the Refresh handler via `WorktreesContext`; only
 *  board-owned view state (search, the appearance view) travels as props. */
export function BoardHeader({
  taskCount,
  projectName,
  projectPath,
  projectBranch,
  search,
  onSearchChange,
  onNewTask,
  appearance,
  backgroundUrl,
}: BoardHeaderProps) {
  const {
    concurrency,
    autoMode,
    autoCommitOnVerified,
    onToggleAutoMode,
    onAutoCommitChange,
    onConcurrencyChange,
    onChangeAppearance,
    onPickBackground,
    onClearBackground,
  } = useBoardChrome();
  const { refreshWorktrees } = useWorktreesContext();
  const inspector = useInspector();
  const bgPanel = useBoardBackgroundPanel();

  return (
    <>
      <div className="flex flex-col gap-3.5 border-b border-border px-[22px] pb-3.5 pt-[18px]">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[21px] font-semibold tracking-tight">Kanban Board</h1>
              <span className="rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {taskCount} tasks
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

          <Toolbar label="Board actions" className="ml-auto">
            <div
              title="Max parallel runs"
              className="flex shrink-0 items-center gap-2.5 rounded-[9px] border border-border bg-white/[0.02] px-3 py-1.5"
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
            <AutoModeOptions
              autoCommitOnVerified={autoCommitOnVerified}
              onAutoCommitChange={onAutoCommitChange}
            />
            <IconButton
              label="Refresh board & worktrees"
              onClick={refreshWorktrees}
              className="border border-border bg-white/[0.02] p-2 hover:border-white/20"
            >
              <RefreshIcon size={15} className="text-muted-foreground" />
            </IconButton>
            <button
              type="button"
              onClick={bgPanel.show}
              title="Customize the board background"
              aria-label="Board background settings"
              className="flex items-center justify-center rounded-[9px] border border-border bg-white/[0.02] p-2 text-foreground transition-colors hover:border-white/20"
            >
              <ImageIcon size={15} className="text-muted-foreground" />
            </button>
            <Button
              variant="secondary"
              onClick={inspector.show}
              title="Inspect the provider configuration for this project"
            >
              <SlidersIcon size={14} className="text-muted-foreground" />
              Provider
            </Button>
            <Button onClick={onNewTask}>
              <PlusIcon size={14} />
              New task
              <Kbd>N</Kbd>
            </Button>
          </Toolbar>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[220px] max-w-[420px] flex-1 items-center gap-2.5 rounded-[9px] border border-border bg-white/[0.02] px-3 py-2">
            <SearchIcon size={15} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search tasks"
              placeholder="Search tasks by keyword…"
              className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>

      <ProviderConfigPanel
        open={inspector.open}
        projectName={projectName}
        projectPath={projectPath}
        onClose={inspector.hide}
      />

      <BoardBackgroundPanel
        open={bgPanel.open}
        appearance={appearance}
        backgroundUrl={backgroundUrl}
        onChangeAppearance={onChangeAppearance}
        onPickImage={onPickBackground}
        onClearImage={onClearBackground}
        onClose={bgPanel.hide}
      />
    </>
  );
}
