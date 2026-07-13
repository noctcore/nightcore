import { lazy, Suspense } from 'react';

import { Board, EMPTY_TRANSCRIPT } from '@/components/board';
import type { ScanFamily } from '@/components/history';
import {
  AnimatePresence,
  Button,
  EmptyState,
  fadeRise,
  FolderIcon,
  m,
} from '@/components/ui';
import type { PermissionPrompt, QuestionPrompt } from '@/lib/bridge';
import type { ScanTarget } from '@/lib/source-ref';
import { requestOpenTerminalInCwd } from '@/lib/terminal-links';

import type { AppShellState } from './AppShell.hooks';

// Off-first-paint route views are code-split (client-bundle): the entry chunk
// only needs Splash + Sidebar + Board, so the Settings/Projects surfaces and the
// TaskDetail drawer — which pull in heavier deps (e.g. marked + dompurify via
// <Markdown>) — load on demand behind a Suspense boundary.
const TaskDetail = lazy(() =>
  import('@/components/board').then((m) => ({ default: m.TaskDetail })),
);
const SettingsView = lazy(() =>
  import('@/components/settings').then((m) => ({ default: m.SettingsView })),
);
// Understand hosts Insight (Find) + Scorecard (Grade) internally, so those two
// feature views are no longer imported here directly — they load transitively
// through UnderstandView's own lazy chunk.
const UnderstandView = lazy(() =>
  import('../UnderstandView').then((m) => ({ default: m.UnderstandView })),
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
const TerminalView = lazy(() =>
  import('@/components/terminal').then((m) => ({ default: m.TerminalView })),
);
const HistoryView = lazy(() =>
  import('@/components/history').then((m) => ({ default: m.HistoryView })),
);

/** Map a History row (family + run) to a run-level provenance target: Insight and
 *  Scorecard both land on the Understand stage (its shell splits by `family`),
 *  Harness on Enforce — mirroring the source-ref REGISTRY's stage mapping. The
 *  `itemId` is empty (run-level), so the stage's preselect selects the run without
 *  opening an item panel. Built inline here (not synthesized as a token) so the
 *  History chunk stays lazy — only the `ScanFamily` type crosses, and types erase. */
function historyRunTarget(family: ScanFamily, runId: string): ScanTarget {
  switch (family) {
    case 'scorecard':
      return { view: 'understand', family: 'scorecard', kind: 'reading', runId, itemId: '' };
    case 'harness':
      return { view: 'enforce', family: 'harness', kind: 'finding', runId, itemId: '' };
    default:
      return { view: 'understand', family: 'insight', kind: 'finding', runId, itemId: '' };
  }
}

/** A minimal fallback while a lazy route view streams in — a quiet centered
 *  status line that never flashes chrome of its own. */
export function RouteFallback() {
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

// Stable empty fallbacks for a task with no parked prompts/questions — a fresh
// `[]` per render would defeat the memoized TaskDetailChrome on every stream flush.
const NO_PROMPTS: PermissionPrompt[] = [];
const NO_QUESTIONS: QuestionPrompt[] = [];

type AppShellViewsProps = Pick<
  AppShellState,
  'registry' | 'routing' | 'board' | 'drawer' | 'settings' | 'onboarding'
> & {
  /** True when nothing is running — gates Settings' idle-only update install. */
  isAppIdle: boolean;
};

/** The in-`<main>` routed-view chain: one of the Board / worktrees / scan / Settings
 *  surfaces cross-fades in on `view` change. Each lazy view keeps its own Suspense
 *  boundary so a not-yet-loaded chunk shows its fallback within the entering view. */
export function AppShellViews({
  registry,
  routing,
  board,
  drawer,
  settings,
  onboarding,
  isAppIdle,
}: AppShellViewsProps) {
  const { active } = registry;
  const { view } = routing;
  const { tasks, selected, selectedId, anyRunning, liveSessionIds } = board;

  return (
    // View-transition seam: the in-<main> view chain cross-fades on `view`
    // change (AnimatePresence keyed on the AppView string, mode="wait" so the
    // outgoing view finishes exiting before the next enters). `initial={false}`
    // skips the animation on first paint. Each lazy view keeps its own
    // <Suspense> INSIDE this keyed container, so a not-yet-loaded chunk shows
    // its fallback within the entering view rather than flashing over the
    // exiting one. The projects↔board full-screen swap (outer ternary) is
    // intentionally NOT keyed here.
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
                    liveSessionIds={liveSessionIds}
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
            <WorktreeView
              tasks={tasks}
              // Open-terminal-here (spec PR 5b): stash the cwd, then route to the Terminal
              // view, which spawns a shell there on mount (the shell owns routing).
              onOpenTerminal={(cwd) => {
                requestOpenTerminalInCwd(cwd);
                routing.goto('terminal');
              }}
            />
          </Suspense>
        )}

        {/* Global user terminal (terminal build spec, PR B): a Project-group
            destination hosting tabbed shells over the PTY backbone. Reads the
            repo root off the active project; worktrees come from the shared
            context inside the view. */}
        {view === 'terminal' && (
          <Suspense fallback={<RouteFallback />}>
            <TerminalView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              webglEnabled={settings.settings?.terminalWebglEnabled ?? false}
              confinedDefault={settings.settings?.terminalConfinedDefault ?? false}
              fontSize={settings.settings?.terminalFontSize ?? null}
              scrollback={settings.settings?.terminalScrollback ?? null}
              tasks={tasks}
              yoloLaunch={settings.settings?.terminalYoloLaunch ?? false}
              aiNaming={settings.settings?.terminalAiNaming ?? false}
              bellNotify={settings.settings?.terminalBellNotify ?? true}
              onConfinedDefaultChange={(confined) =>
                settings.update({ terminalConfinedDefault: confined })
              }
            />
          </Suspense>
        )}

        {/* Global run History (Views Phase 2): one cross-family list of every
            Insight / Scorecard / Harness run for the active project. A row click
            routes run-level into the owning stage (Understand / Enforce) through the
            same preselect seam provenance chips use — no token synthesis. */}
        {view === 'history' && (
          <Suspense fallback={<RouteFallback />}>
            <HistoryView
              projectPath={active?.path ?? null}
              onOpenRun={(family, runId) =>
                routing.gotoScanTarget(historyRunTarget(family, runId))
              }
            />
          </Suspense>
        )}

        {/* Understand stage (Phase-1 PR 3): one shell hosting Insight's Find +
            Scorecard's Grade. The `understand`-view preselect flows in; the shell
            reads `scanTarget.family` to flip to the sub-view that owns it. The
            standalone `insight` / `scorecard` routes were removed in the flip —
            legacy `insight:` / `scorecard:` provenance tokens now retarget here
            through the source-ref REGISTRY. */}
        {view === 'understand' && (
          <Suspense fallback={<RouteFallback />}>
            <UnderstandView
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'understand' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
            />
          </Suspense>
        )}

        {/* Harden / Enforce (Phase-1 PR 3): the same HarnessView run/store, split by
            `mode`. Each gates its preselect on its own stage view key — a
            `harness-proposal:` token retargets to `harden`, a `harness:` convention
            token to `enforce`; the section within HarnessView is then picked by the
            target's `kind`. The standalone unified `harness` route was removed. */}
        {view === 'harden' && (
          <Suspense fallback={<RouteFallback />}>
            <HarnessView
              mode="harden"
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'harden' ? routing.scanTarget : null}
              onPreselectConsumed={routing.clearScanTarget}
            />
          </Suspense>
        )}

        {view === 'enforce' && (
          <Suspense fallback={<RouteFallback />}>
            <HarnessView
              mode="enforce"
              projectPath={active?.path ?? null}
              projectName={active?.name ?? null}
              onGotoBoard={() => routing.goto('board')}
              preselect={routing.scanTarget?.view === 'enforce' ? routing.scanTarget : null}
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
  );
}
