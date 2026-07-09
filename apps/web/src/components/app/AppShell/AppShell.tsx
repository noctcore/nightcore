import { lazy, Suspense } from 'react';

import {
  Board,
  BoardChromeProvider,
  EMPTY_TRANSCRIPT,
  NewTaskForm,
  TaskActionsProvider,
} from '@/components/board';
import { NewProjectDialog } from '@/components/new-project';
import { Onboarding } from '@/components/onboarding';
import { useUpdateChecker } from '@/components/settings/UpdateChecker';
import {
  AnimatePresence,
  Button,
  EmptyState,
  fadeRise,
  FolderIcon,
  m,
} from '@/components/ui';
import type { PermissionPrompt, QuestionPrompt } from '@/lib/bridge';
import { WorktreesProvider } from '@/lib/worktrees-context';

import { Sidebar } from '../Sidebar';
import { Splash } from '../Splash';
import { useAppShell } from './AppShell.hooks';
import { AppShellOverlays } from './AppShellOverlays';
import { useNavShortcuts } from './hooks/useNavShortcuts.hooks';
import { APP_SHELL_NAV } from './nav.constants';

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
const IssueTriageView = lazy(() =>
  import('@/components/issues').then((m) => ({ default: m.IssueTriageView })),
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

// Stable empty fallbacks for a task with no parked prompts/questions — a fresh
// `[]` per render would defeat the memoized TaskDetailChrome on every stream flush.
const NO_PROMPTS: PermissionPrompt[] = [];
const NO_QUESTIONS: QuestionPrompt[] = [];

/** The Nightcore app shell and composition root: it hosts the sidebar, routes
 *  between the Board / Projects / Settings surfaces, and renders the New Project
 *  and TaskDetail overlays. All state lives in `useAppShell`; this is a thin
 *  presentational host wiring views to the live registry, settings, and board. */
export function AppShell() {
  const {
    routing,
    registry,
    settings,
    newProject,
    chrome,
    board,
    drawer,
    prDialog,
    worktrees,
    confirm,
    editProject,
    projectRemoval,
    onboarding,
    showSplash,
    isTauri,
  } = useAppShell();
  const { view, switcherOpen, collapsed, newProjectOpen } = routing;
  const { projects, active } = registry;
  const sidebarStyle =
    settings.settings?.sidebarStyle === 'classic' ? 'classic' : 'unified';
  const { tasks, selected, selectedId, setSelectedId, anyRunning, runningCount } = board;
  const isAppIdle = runningCount === 0;

  // Background update probe — idle-gated install stays in Settings → About.
  useUpdateChecker({ isAppIdle, checkOnStartup: true });

  const runningProjectIds = anyRunning && active !== null ? [active.id] : [];

  // Wire the sidebar's Kbd hints to real navigation. Only while the sidebar is on
  // screen — not during the splash or the full-screen, sidebar-less Projects
  // surface (view==='projects' or no active project).
  const shortcutsEnabled =
    !showSplash && registry.loaded && view !== 'projects' && active !== null;
  useNavShortcuts(APP_SHELL_NAV, routing.goto, shortcutsEnabled);

  // Hold the splash until the registry has loaded — in EVERY environment, not just
  // Tauri — so the first real paint already knows whether to land on full-screen
  // Projects or a restored board. Gating only on Tauri let the browser preview paint
  // with `active` still null, flashing Projects before the board. (useProjectRegistry
  // caps the load with a timeout so a wedged backend can't hang the splash forever.)
  if (showSplash || !registry.loaded) {
    return <Splash bootLine="loading workspace…" />;
  }

  if (onboarding.show) {
    return (
      <Onboarding
        folder={newProject.folder}
        gitState={newProject.gitState}
        onChooseFolder={newProject.pickFolder}
        onInitGit={newProject.initGit}
        onCreateProject={async (name) => {
          if (newProject.folder === null) return;
          await newProject.createDefault(name);
        }}
        onSkip={() => {
          onboarding.dismiss();
          routing.goto('projects');
        }}
        onComplete={() => {
          onboarding.dismiss();
          routing.goto('board');
        }}
      />
    );
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
        onEdit={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p !== undefined) editProject.openEdit(p);
        }}
        onRename={registry.rename}
        onDelete={projectRemoval.request}
        onNewProject={routing.openNewProject}
      />
    </Suspense>
  );

  return (
    // The shell's grouped task actions, the shared worktrees slice, and the board
    // chrome cluster travel by context (not props). All three provider values are
    // referentially stable across `nc:session` stream flushes (the `detailActions`,
    // `useWorktreesValue`, and `useBoardChromeValue` memos), so none churns its
    // consumers per-frame.
    <TaskActionsProvider actions={drawer.detailActions}>
    <WorktreesProvider value={worktrees}>
    <BoardChromeProvider value={chrome}>
      {showProjects ? (
        <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
          {browserPreviewBanner}
          <div className="min-h-0 flex-1">{projectsSurface}</div>
        </div>
      ) : (
        <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
          <Sidebar
            switcher={{
              projects,
              active,
              switcherOpen,
              onToggleSwitcher: routing.toggleSwitcher,
              onPickProject: registry.activate,
              onNewProject: routing.openNewProject,
              onEditProject: editProject.openEdit,
              onRemoveProject: projectRemoval.request,
            }}
            view={view}
            nav={APP_SHELL_NAV}
            collapsed={collapsed}
            sidebarStyle={sidebarStyle}
            runningCount={runningCount}
            awaitingInputCount={board.promptIds.size}
            version="v0.1.0"
            onToggleCollapsed={routing.toggleCollapsed}
            onNavigate={routing.goto}
            onGotoProjects={() => routing.goto('projects')}
            onGotoAwaitingInput={() => {
              // Select the first task parked awaiting input and open its board
              // drawer (where the InteractionDock renders the prompt to act on).
              const first = board.promptIds.values().next().value;
              if (first === undefined) return;
              setSelectedId(first);
              routing.goto('board');
            }}
          />

          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {browserPreviewBanner}

            {/* View-transition seam: the in-<main> view chain cross-fades on `view`
                change (AnimatePresence keyed on the AppView string, mode="wait" so the
                outgoing view finishes exiting before the next enters). `initial={false}`
                skips the animation on first paint. Each lazy view keeps its own
                <Suspense> INSIDE this keyed container, so a not-yet-loaded chunk shows
                its fallback within the entering view rather than flashing over the
                exiting one. The projects↔board full-screen swap (outer ternary) is
                intentionally NOT keyed here. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={view}
                variants={fadeRise}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex min-h-0 flex-1 flex-col"
              >

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
                  selectedId={selectedId}
                  logCounts={board.logCounts}
                  blockedIds={board.blockedIds}
                  promptIds={board.promptIds}
                  onNewTask={routing.openNewTask}
                  onMoveTask={board.handleMoveTask}
                  onClearColumn={board.requestClear}
                />
              )}
            </div>

            {/* Drawer presence: AnimatePresence lives at the mount conditional so
                the drawer's `m.aside` (slideIn variant) can play its exit on close.
                TaskDetail is already loaded by the time it exits, so the Suspense
                fallback never flashes. */}
            <AnimatePresence>
              {selected !== null && (
                <Suspense fallback={null}>
                  <TaskDetail
                    task={selected}
                    stream={drawer.streams[selected.id] ?? EMPTY_TRANSCRIPT}
                    anyRunning={anyRunning}
                    prompts={drawer.prompts[selected.id] ?? NO_PROMPTS}
                    questions={drawer.questions[selected.id] ?? NO_QUESTIONS}
                    gauntlet={drawer.gauntletResults[selected.id] ?? null}
                    gauntletRunning={drawer.gauntletRunning.has(selected.id)}
                    onClose={drawer.closeDetail}
                    // The drawer's ~25 action callbacks arrive via the
                    // TaskActionsProvider above (one grouped, referentially stable
                    // object — `detailActions`). Delete routes through the
                    // confirm-gated `requestDelete` (matching the card/column deletes).
                    isActionPending={drawer.isActionPending}
                    // Provenance chip → the originating scan run/item (routing concern).
                    onOpenSourceRef={routing.gotoSourceRef}
                  />
                </Suspense>
              )}
            </AnimatePresence>
          </div>
        )}

        {view === 'worktrees' && (
          <Suspense fallback={<RouteFallback />}>
            <WorktreeView tasks={tasks} />
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

        {view === 'issuetriage' && (
          <Suspense fallback={<RouteFallback />}>
            <IssueTriageView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'issuetriage' ? routing.scanTarget : null}
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
            onRestartOnboarding={onboarding.restart}
            isAppIdle={isAppIdle}
          />
          </Suspense>
        )}
              </m.div>
            </AnimatePresence>
          </main>
        </div>
      )}

      <NewTaskForm
        open={routing.newTaskOpen}
        onCreate={board.handleCreate}
        onClose={routing.closeNewTask}
      />

      <NewProjectDialog
        open={newProjectOpen}
        folder={newProject.folder}
        gitState={newProject.gitState}
        onChooseFolder={newProject.pickFolder}
        onInitGit={newProject.initGit}
        onCreate={newProject.create}
        onClose={() => {
          routing.closeNewProject();
          newProject.reset();
        }}
      />

      {/* The Create PR human gate: opened from the drawer's Create PR button;
          the mutation (push + `gh pr create`) only fires from its confirm. Mounted
          once first opened (a one-way latch) so the lazy dialog can animate closed. */}
      {prDialog.prDialogMounted && (
        <Suspense fallback={null}>
          <CreatePRDialog
            open={prDialog.prDialogTaskId !== null}
            task={tasks.find((t) => t.id === prDialog.prDialogTaskId) ?? null}
            onCreate={prDialog.handleCreatePr}
            onClose={prDialog.closePrDialog}
          />
        </Suspense>
      )}

      <AppShellOverlays confirm={confirm} editProject={editProject} projectRemoval={projectRemoval} />
    </BoardChromeProvider>
    </WorktreesProvider>
    </TaskActionsProvider>
  );
}
