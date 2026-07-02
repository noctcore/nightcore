import { lazy, Suspense } from 'react';

import { Board, EMPTY_TRANSCRIPT, NewTaskForm } from '@/components/board';
import { NewProjectDialog } from '@/components/new-project';
import {
  BoardIcon,
  BranchIcon,
  Button,
  ConfirmDialog,
  EmptyState,
  FolderIcon,
  GearIcon,
  GithubIcon,
  InsightIcon,
  PerfIcon,
  VerifiedIcon,
} from '@/components/ui';
import type { PermissionPrompt, QuestionPrompt } from '@/lib/bridge';

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
const ScorecardView = lazy(() =>
  import('@/components/scorecard').then((m) => ({ default: m.ScorecardView })),
);
const HarnessView = lazy(() =>
  import('@/components/harness').then((m) => ({ default: m.HarnessView })),
);
const PrReviewView = lazy(() =>
  import('@/components/prreview').then((m) => ({ default: m.PrReviewView })),
);
const WorktreeView = lazy(() =>
  import('@/components/worktree').then((m) => ({ default: m.WorktreeView })),
);
// The Create PR dialog mounts on demand only (an explicit button click), so it
// shares the worktree feature's lazy chunk instead of joining the entry bundle.
const CreatePRDialog = lazy(() =>
  import('@/components/worktree').then((m) => ({ default: m.CreatePRDialog })),
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

// Projects is no longer a workspace nav item — the sidebar brand/logo is its entry
// point (and the shell shows it full-screen, without the sidebar). The remaining
// items route within an open project.
const NAV: NavItem[] = [
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: <BoardIcon size={16} /> },
  { view: 'worktrees', label: 'Worktrees', hint: 'W', icon: <BranchIcon size={16} /> },
  { view: 'insight', label: 'Insight', hint: 'I', icon: <InsightIcon size={16} /> },
  { view: 'scorecard', label: 'Scorecard', hint: 'R', icon: <PerfIcon size={16} /> },
  { view: 'harness', label: 'Harness', hint: 'H', icon: <VerifiedIcon size={16} /> },
  { view: 'prreview', label: 'PR Review', hint: 'P', icon: <GithubIcon size={16} /> },
  { view: 'settings', label: 'Settings', hint: 'S', icon: <GearIcon size={16} /> },
];

const MODELS = ['Opus 4.8', 'Sonnet 4.8', 'Haiku 4.5'];

// Stable empty fallbacks for a task with no parked prompts/questions — a fresh
// `[]` per render would defeat the memoized TaskDetailChrome on every stream flush.
const NO_PROMPTS: PermissionPrompt[] = [];
const NO_QUESTIONS: QuestionPrompt[] = [];

/** The Nightcore app shell and composition root: it hosts the sidebar, routes
 *  between the Board / Projects / Settings surfaces, and renders the New Project
 *  and TaskDetail overlays. All state lives in `useAppShell`; this is a thin
 *  presentational host wiring views to the live registry, settings, and board. */
export function AppShell() {
  const { routing, registry, settings, autoLoop, newProject, board, confirm, showSplash, isTauri } =
    useAppShell();
  const { view, switcherOpen, collapsed, newProjectOpen } = routing;
  const { projects, active } = registry;
  const { tasks, selected, selectedId, setSelectedId, anyRunning } = board;

  const runningProjectIds = anyRunning && active !== null ? [active.id] : [];

  // Hold the splash until the registry has loaded — in EVERY environment, not just
  // Tauri — so the first real paint already knows whether to land on full-screen
  // Projects or a restored board. Gating only on Tauri let the browser preview paint
  // with `active` still null, flashing Projects before the board. (useProjectRegistry
  // caps the load with a timeout so a wedged backend can't hang the splash forever.)
  if (showSplash || !registry.loaded) {
    return <Splash bootLine="loading workspace…" />;
  }

  // The Projects surface is full-screen and chrome-free: shown when explicitly
  // navigated to (the brand/logo) OR whenever there's no active project to frame a
  // board around. Opening a project (or having one restored) reveals the sidebar.
  const showProjects = view === 'projects' || active === null;

  const browserPreviewBanner = !isTauri && (
    <p className="border-b border-warning/40 bg-warning/[0.12] px-5 py-2 text-sm text-warning">
      Browser preview — run <code className="font-mono">bun run desktop</code> to
      drive the sidecar. Commands no-op here with mock data.
    </p>
  );

  const projectsSurface = (
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
  );

  return (
    <>
      {showProjects ? (
        <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
          {browserPreviewBanner}
          <div className="min-h-0 flex-1">{projectsSurface}</div>
        </div>
      ) : (
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
            onGotoProjects={() => routing.goto('projects')}
            onPickProject={registry.activate}
            onNewProject={routing.openNewProject}
          />

          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {browserPreviewBanner}

            {view === 'board' && (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {/* `active === null` is unreachable here — `showProjects` routes the
                  no-active-project case to the full-screen Projects surface above, so
                  this branch only renders with a non-null project. It stays as the
                  type-narrowing guard for `active.name`/`.path`/`.branch` below (and a
                  defensive fallback), not as a real UX path. */}
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
                  projectId={active.id}
                  projectName={active.name}
                  projectPath={active.path}
                  projectBranch={active.branch}
                  appearanceOverride={
                    settings.settings?.projectOverrides[active.id]?.boardAppearance ?? null
                  }
                  backgroundVersion={
                    settings.settings?.projectOverrides[active.id]?.boardBackground?.version ?? null
                  }
                  onChangeAppearance={(next) =>
                    settings.update({ projectId: active.id, boardAppearance: next })
                  }
                  onPickBackground={(image) => settings.setBackground(active.id, image)}
                  onClearBackground={() => settings.clearBackground(active.id)}
                  worktrees={board.worktrees}
                  activeWorktree={board.activeWorktree}
                  onSelectWorktree={board.setActiveWorktree}
                  concurrency={autoLoop.concurrency}
                  autoMode={autoLoop.autoMode}
                  autoCommitOnVerified={settings.settings?.autoCommitOnVerified ?? false}
                  breaker={autoLoop.breaker}
                  selectedId={selectedId}
                  logCounts={board.logCounts}
                  blockedIds={board.blockedIds}
                  promptIds={board.promptIds}
                  onSelect={setSelectedId}
                  onNewTask={routing.openNewTask}
                  onRun={board.handleRun}
                  onCancel={board.handleCancel}
                  onDelete={board.requestDelete}
                  onMoveTask={board.handleMoveTask}
                  onClearColumn={board.requestClear}
                  onApprove={board.handleApprove}
                  onRefine={board.handleRefine}
                  onCommit={board.handleCommit}
                  onMerge={board.handleMerge}
                  isActionPending={board.isActionPending}
                  onToggleAutoMode={autoLoop.toggleAutoMode}
                  onAutoCommitChange={(next) =>
                    settings.update({ autoCommitOnVerified: next })
                  }
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
                prompts={board.prompts[selected.id] ?? NO_PROMPTS}
                questions={board.questions[selected.id] ?? NO_QUESTIONS}
                gauntlet={board.gauntletResults[selected.id] ?? null}
                gauntletRunning={board.gauntletRunning.has(selected.id)}
                onClose={board.closeDetail}
                // The drawer's ~25 action callbacks travel as one grouped object,
                // pre-assembled once in the `board` controller (`detailActions`) so
                // its identity is stable across the per-frame stream flush. Delete
                // routes through the confirm-gated `requestDelete` (matching the
                // card/column deletes).
                actions={board.detailActions}
                isActionPending={board.isActionPending}
                // Provenance chip → the originating scan run/item (routing concern).
                onOpenSourceRef={routing.gotoSourceRef}
              />
              </Suspense>
            )}
          </div>
        )}

        {view === 'worktrees' && (
          <Suspense fallback={<RouteFallback />}>
            <WorktreeView worktrees={board.worktrees} tasks={tasks} />
          </Suspense>
        )}

        {view === 'insight' && (
          <Suspense fallback={<RouteFallback />}>
            <InsightView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'insight' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
            />
          </Suspense>
        )}

        {view === 'scorecard' && (
          <Suspense fallback={<RouteFallback />}>
            <ScorecardView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'scorecard' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
            />
          </Suspense>
        )}

        {view === 'harness' && (
          <Suspense fallback={<RouteFallback />}>
            <HarnessView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'harness' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
            />
          </Suspense>
        )}

        {view === 'prreview' && (
          <Suspense fallback={<RouteFallback />}>
            <PrReviewView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'prreview' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
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
        </div>
      )}

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

      {/* The Create PR human gate: opened from the drawer's Create PR button;
          the mutation (push + `gh pr create`) only fires from its confirm. */}
      {board.prDialogTaskId !== null && (
        <Suspense fallback={null}>
          <CreatePRDialog
            open
            task={tasks.find((t) => t.id === board.prDialogTaskId) ?? null}
            onCreate={board.handleCreatePr}
            onClose={board.closePrDialog}
          />
        </Suspense>
      )}

      {confirm.pendingDelete !== null && (
        <ConfirmDialog
          title="Delete this task?"
          message="This task and its run history will be removed. This can't be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={confirm.confirm}
          onCancel={confirm.cancel}
        />
      )}

      {confirm.pendingClear !== null && (
        <ConfirmDialog
          title={`Delete all ${confirm.pendingClear.count} tasks in ${confirm.pendingClear.columnTitle}?`}
          message={`Every task in ${confirm.pendingClear.columnTitle} will be removed. This can't be undone.`}
          confirmLabel="Delete all"
          destructive
          onConfirm={confirm.confirm}
          onCancel={confirm.cancel}
        />
      )}
    </>
  );
}
