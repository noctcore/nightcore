import { lazy, Suspense } from 'react';
import { Board, EMPTY_TRANSCRIPT, NewTaskForm } from '@/components/board';
import { NewProjectDialog } from '@/components/new-project';
import {
  BoardIcon,
  Button,
  EmptyState,
  FolderIcon,
  GearIcon,
  InsightIcon,
  LayersIcon,
} from '@/components/ui';
import { Sidebar } from '../Sidebar';
import { Splash } from '../Splash';
import { useAppShell } from './AppShell.hooks';
import type { NavItem } from './AppShell.types';

// Off-first-paint route views are code-split (client-bundle): the entry chunk
// only needs Splash + Sidebar + Board, so the Settings/Projects surfaces and the
// TaskDetail drawer — which pull in heavier deps (e.g. marked + dompurify via
// <Markdown>) — load on demand behind a Suspense boundary.
const TaskDetail = lazy(() =>
  import('@/components/board').then((m) => ({ default: m.TaskDetail })),
);
const ProjectsView = lazy(() =>
  import('@/components/projects').then((m) => ({ default: m.ProjectsView })),
);
const SettingsView = lazy(() =>
  import('@/components/settings').then((m) => ({ default: m.SettingsView })),
);
const InsightView = lazy(() =>
  import('@/components/insight').then((m) => ({ default: m.InsightView })),
);

/** A minimal fallback while a lazy route view streams in — a quiet centered
 *  status line that never flashes chrome of its own. */
function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-full w-full items-center justify-center text-sm text-muted-foreground"
    >
      Loading…
    </div>
  );
}

const NAV: NavItem[] = [
  { view: 'projects', label: 'Projects', hint: 'P', icon: <LayersIcon size={16} /> },
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: <BoardIcon size={16} /> },
  { view: 'insight', label: 'Insight', hint: 'I', icon: <InsightIcon size={16} /> },
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
              ) : (
                <Board
                  tasks={tasks}
                  projectName={active.name}
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
              <Suspense fallback={null}>
              <TaskDetail
                task={selected}
                stream={board.streams[selected.id] ?? EMPTY_TRANSCRIPT}
                anyRunning={anyRunning}
                prompts={board.prompts[selected.id] ?? []}
                questions={board.questions[selected.id] ?? []}
                gauntlet={board.gauntletResults[selected.id] ?? null}
                gauntletRunning={board.gauntletRunning.has(selected.id)}
                onClose={() => setSelectedId(null)}
                onRun={board.handleRun}
                onCancel={board.handleCancel}
                onDelete={board.handleDelete}
                onRespondPermission={board.handleRespondPermission}
                onAnswerQuestion={board.handleAnswerQuestion}
                onApprove={board.handleApprove}
                onReject={board.handleReject}
                onRefine={board.handleRefine}
                onChangeKind={board.handleChangeKind}
                onChangeRunMode={board.handleChangeRunMode}
                onChangePermissionMode={board.handleChangePermissionMode}
                onChangeModel={board.handleChangeModel}
                onChangeEffort={board.handleChangeEffort}
                onChangeMaxTurns={board.handleChangeMaxTurns}
                onChangeMaxBudget={board.handleChangeMaxBudget}
                onAcceptReview={board.handleAcceptReview}
                onRejectReview={board.handleRejectReview}
                onRerunVerification={board.handleRerunVerification}
                onRunGauntlet={board.handleRunGauntlet}
                onMerge={board.handleMerge}
                onCommit={board.handleCommit}
                onResumeSession={board.handleResumeSession}
                onRenameSession={board.handleRenameSession}
                onTagSession={board.handleTagSession}
                isActionPending={board.isActionPending}
              />
              </Suspense>
            )}
          </div>
        )}

        {view === 'insight' && (
          <Suspense fallback={<RouteFallback />}>
            <InsightView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
            />
          </Suspense>
        )}

        {view === 'projects' && (
          <Suspense fallback={<RouteFallback />}>
          <ProjectsView
            projects={projects}
            activeId={active?.id ?? null}
            activeTasks={tasks}
            runningProjectIds={runningProjectIds}
            onOpen={(id) => {
              registry.activate(id);
              routing.goto('board');
            }}
            onRename={registry.rename}
            onDelete={registry.remove}
            onNewProject={routing.openNewProject}
          />
          </Suspense>
        )}

        {view === 'settings' && settings.settings !== null && (
          <Suspense fallback={<RouteFallback />}>
          <SettingsView
            settings={settings.settings}
            activeProjectId={active?.id ?? null}
            activeProjectName={active?.name ?? null}
            activeProjectPath={active?.path ?? null}
            onUpdate={settings.update}
          />
          </Suspense>
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
