import { lazy, Suspense } from 'react';

import {
  BoardChromeProvider,
  NewTaskForm,
  RunGateProvider,
  TaskActionsProvider,
  UsageHotProvider,
} from '@/components/board';
import { NewProjectDialog } from '@/components/new-project';
import { Onboarding } from '@/components/onboarding';
import { useAppInfo } from '@/components/settings/SettingsView';
import { useUpdateChecker } from '@/components/settings/UpdateChecker';
import { WorktreesProvider } from '@/lib/worktrees-context';

import { Sidebar } from '../Sidebar';
import { Splash } from '../Splash';
import { UsageMeter } from '../UsageMeter';
import { useAppShell } from './AppShell.hooks';
import { AppShellOverlays } from './AppShellOverlays';
import { AppShellViews, RouteFallback } from './AppShellViews';
import { useBoardShortcuts } from './hooks/useBoardShortcuts.hooks';
import { useNavShortcuts } from './hooks/useNavShortcuts.hooks';
import { APP_SHELL_NAV } from './nav.constants';

// Projects keeps its full-screen surface in the entry bundle boundary here; the
// heavier routed views (Board drawer, Settings, scan surfaces) are code-split in
// AppShellViews.
const ProjectsView = lazy(() =>
  import('@/components/projects').then((m) => ({ default: m.ProjectsView })),
);
// The Create PR dialog mounts on demand only (an explicit button click), so it
// shares the worktree feature's lazy chunk instead of joining the entry bundle.
const CreatePRDialog = lazy(() =>
  import('@/components/worktree').then((m) => ({ default: m.CreatePRDialog })),
);

// Projects is no longer a workspace nav item — the sidebar brand/logo is its entry
// point (and the shell shows it full-screen, without the sidebar). The remaining
// items route within an open project.

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
    usageHot,
    runSlots,
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
  const { tasks, setSelectedId, anyRunning, runningCount } = board;
  const isAppIdle = runningCount === 0;

  // The real app version, sourced from the build-time Cargo package version (the
  // same `app_info` the About page reads) instead of a hardcoded literal that drifts
  // every release. Empty until it resolves, so the footer never flashes a wrong tag.
  const appInfo = useAppInfo();
  const appVersion = appInfo !== null ? `v${appInfo.version}` : '';
  // The active agent provider gates which onboarding prerequisites are required.
  const activeProvider = settings.settings?.provider ?? 'claude';

  // Background update probe — idle-gated install stays in Settings → About. Its
  // result was previously discarded; T11 surfaces a ready update as a passive
  // sidebar-footer pill (the install action still lives in About).
  const updater = useUpdateChecker({ isAppIdle, checkOnStartup: true });
  const sidebarUpdate =
    updater.update !== null
      ? { version: updater.update.version, onGoto: () => routing.goto('settings') }
      : null;

  const runningProjectIds = anyRunning && active !== null ? [active.id] : [];

  // Wire the sidebar's Kbd hints to real navigation. Only while the sidebar is on
  // screen — not during the splash or the full-screen, sidebar-less Projects
  // surface (view==='projects' or no active project).
  const shortcutsEnabled =
    !showSplash && registry.loaded && view !== 'projects' && active !== null;
  useNavShortcuts(APP_SHELL_NAV, routing.goto, shortcutsEnabled);

  // The board keyboard layer (T13): N (new task) / Esc (close drawer) / `/` (focus
  // search). Active only on the board view with no modal open, so it never fights the
  // NewTaskForm's own Esc-to-close or a scan surface's inputs. Both callbacks are stable
  // (`routing.openNewTask` and the memoized `drawer.closeDetail`), so the listener
  // subscribes once per enable.
  useBoardShortcuts({
    enabled: shortcutsEnabled && view === 'board' && !routing.newTaskOpen && !newProjectOpen,
    drawerOpen: board.selectedId !== null,
    onNewTask: routing.openNewTask,
    onCloseDrawer: drawer.closeDetail,
  });

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
        activeProvider={activeProvider}
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
    <UsageHotProvider value={usageHot}>
    <RunGateProvider value={runSlots}>
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
            version={appVersion}
            update={sidebarUpdate}
            footerSlot={<UsageMeter collapsed={collapsed} />}
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

            <AppShellViews
              registry={registry}
              routing={routing}
              board={board}
              drawer={drawer}
              settings={settings}
              onboarding={onboarding}
              isAppIdle={isAppIdle}
            />
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
    </RunGateProvider>
    </UsageHotProvider>
    </WorktreesProvider>
    </TaskActionsProvider>
  );
}
