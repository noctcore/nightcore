import { Board, EMPTY_STREAM, NewTaskForm, TaskDetail } from '@/components/board';
import { ProjectsView } from '@/components/projects';
import { SettingsView } from '@/components/settings';
import { NewProjectDialog } from '@/components/new-project';
import {
  BoardIcon,
  Button,
  EmptyState,
  FolderIcon,
  GearIcon,
  LayersIcon,
} from '@/components/ui';
import { Sidebar } from '../Sidebar';
import { Splash } from '../Splash';
import { useAppShell } from './AppShell.hooks';
import type { NavItem } from './AppShell.types';

const NAV: NavItem[] = [
  { view: 'projects', label: 'Projects', hint: 'P', icon: <LayersIcon size={16} /> },
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: <BoardIcon size={16} /> },
  { view: 'settings', label: 'Settings', hint: 'S', icon: <GearIcon size={16} /> },
];

const MODELS = ['Opus 4.8', 'Sonnet 4.8', 'Haiku 4.5'];

/** The Nightcore app shell and composition root: it hosts the sidebar, routes
 *  between the Board / Projects / Settings surfaces, and renders the New Project
 *  and TaskDetail overlays. All state lives in `useAppShell`; this is a thin
 *  presentational host wiring views to the live registry, settings, and board. */
export function AppShell() {
  const { routing, registry, settings, autoLoop, newProject, board, showSplash, isTauri } =
    useAppShell();
  const { view, switcherOpen, collapsed, newProjectOpen } = routing;
  const { projects, active } = registry;
  const { tasks, selected, selectedId, setSelectedId, anyRunning } = board;

  const runningProjectIds = anyRunning && active !== null ? [active.id] : [];

  if (showSplash) {
    return <Splash bootLine="loading workspace…" />;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        projects={projects}
        active={active}
        view={view}
        nav={NAV}
        collapsed={collapsed}
        switcherOpen={switcherOpen}
        runningCount={anyRunning ? 1 : 0}
        version="v0.1.0"
        onToggleCollapsed={routing.toggleCollapsed}
        onToggleSwitcher={routing.toggleSwitcher}
        onNavigate={routing.goto}
        onPickProject={registry.activate}
        onNewProject={routing.openNewProject}
      />

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {!isTauri && (
          <p className="border-b border-warning/40 bg-warning/[0.12] px-5 py-2 text-sm text-warning">
            Browser preview — run{' '}
            <code className="font-mono">bun run desktop</code> to drive the sidecar.
            Commands no-op here with mock data.
          </p>
        )}

        {view === 'board' && (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {active === null ? (
                <EmptyState
                  icon={<FolderIcon size={32} />}
                  title="No active project"
                  description="Open a project to see its board. Each project keeps its own tasks."
                  action={<Button onClick={() => routing.goto('projects')}>Go to Projects</Button>}
                />
              ) : tasks.length === 0 ? (
                <EmptyState
                  icon={<BoardIcon size={32} />}
                  title="No tasks yet"
                  description="Describe what you want built. Each task becomes a card an agent can pick up and run."
                  action={<Button onClick={routing.openNewTask}>Create your first task</Button>}
                />
              ) : (
                <Board
                  tasks={tasks}
                  projectPath={active.path}
                  projectBranch={active.branch}
                  worktrees={board.worktrees}
                  activeWorktree={board.activeWorktree}
                  onSelectWorktree={board.setActiveWorktree}
                  concurrency={autoLoop.concurrency}
                  autoMode={autoLoop.autoMode}
                  breaker={autoLoop.breaker}
                  selectedId={selectedId}
                  logCounts={board.logCounts}
                  blockedIds={board.blockedIds}
                  promptIds={board.promptIds}
                  onSelect={setSelectedId}
                  onNewTask={routing.openNewTask}
                  onRun={board.handleRun}
                  onCancel={board.handleCancel}
                  onDelete={board.handleDelete}
                  onMoveTask={board.handleMoveTask}
                  onClearColumn={board.handleClearColumn}
                  onApprove={board.handleApprove}
                  onRefine={board.handleRefine}
                  onCommit={board.handleCommit}
                  onMerge={board.handleMerge}
                  onToggleAutoMode={autoLoop.toggleAutoMode}
                  onConcurrencyChange={autoLoop.changeConcurrency}
                  onResume={autoLoop.resume}
                />
              )}
            </div>

            {selected !== null && (
              <TaskDetail
                task={selected}
                stream={board.streams[selected.id] ?? EMPTY_STREAM}
                anyRunning={anyRunning}
                prompts={board.prompts[selected.id] ?? []}
                gauntlet={board.gauntletResults[selected.id] ?? null}
                gauntletRunning={board.gauntletRunning.has(selected.id)}
                onClose={() => setSelectedId(null)}
                onRun={board.handleRun}
                onCancel={board.handleCancel}
                onDelete={board.handleDelete}
                onRespondPermission={board.handleRespondPermission}
                onApprove={board.handleApprove}
                onReject={board.handleReject}
                onRefine={board.handleRefine}
                onChangeKind={board.handleChangeKind}
                onChangeRunMode={board.handleChangeRunMode}
                onChangePermissionMode={board.handleChangePermissionMode}
                onChangeModel={board.handleChangeModel}
                onChangeEffort={board.handleChangeEffort}
                onAcceptReview={board.handleAcceptReview}
                onRejectReview={board.handleRejectReview}
                onRerunVerification={board.handleRerunVerification}
                onRunGauntlet={board.handleRunGauntlet}
                onMerge={board.handleMerge}
                onCommit={board.handleCommit}
              />
            )}
          </div>
        )}

        {view === 'projects' && (
          <ProjectsView
            projects={projects}
            activeId={active?.id ?? null}
            activeTasks={tasks}
            runningProjectIds={runningProjectIds}
            onOpen={(id) => {
              registry.activate(id);
              routing.goto('board');
            }}
            onDelete={registry.remove}
            onNewProject={routing.openNewProject}
          />
        )}

        {view === 'settings' && settings.settings !== null && (
          <SettingsView
            settings={settings.settings}
            activeProjectId={active?.id ?? null}
            activeProjectName={active?.name ?? null}
            activeProjectPath={active?.path ?? null}
            onUpdate={settings.update}
          />
        )}
      </main>

      {routing.newTaskOpen && (
        <NewTaskForm onCreate={board.handleCreate} onClose={routing.closeNewTask} />
      )}

      {newProjectOpen && (
        <NewProjectDialog
          models={MODELS}
          folder={newProject.folder}
          gitState={newProject.gitState}
          onChooseFolder={newProject.pickFolder}
          onInitGit={newProject.initGit}
          onCreate={(draft) => {
            if (draft.folder === null) return;
            void newProject.create(draft.folder, draft.name);
          }}
          onClose={() => {
            routing.closeNewProject();
            newProject.reset();
          }}
        />
      )}
    </div>
  );
}
