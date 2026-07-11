import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type BoardChromeValue,
  isActive,
  type TaskDetailActions,
  type TaskTranscript,
} from '@/components/board';
import { useToast } from '@/components/ui';
import {
  type GauntletResult,
  isTauri,
  type PermissionPrompt,
  type QuestionPrompt,
  type Task,
} from '@/lib/bridge';
import { requestActivateSession } from '@/lib/terminal-links';
import type { WorktreesContextValue } from '@/lib/worktrees-context';

import { useActionGuard } from './hooks/useActionGuard.hooks';
import { useAutoLoop } from './hooks/useAutoLoop.hooks';
import { useBlockedIds } from './hooks/useBlockedIds.hooks';
import { useBoard } from './hooks/useBoard.hooks';
import { type BoardActions, useBoardActions } from './hooks/useBoardActions.hooks';
import { useBoardChromeValue } from './hooks/useBoardChromeValue.hooks';
import { type CreatePrController, useCreatePr } from './hooks/useCreatePr.hooks';
import { useEditProject } from './hooks/useEditProject.hooks';
import { useGauntlet } from './hooks/useGauntlet.hooks';
import { useGlobalErrorToast } from './hooks/useGlobalErrorToast.hooks';
import { useNewProjectFlow } from './hooks/useNewProjectFlow.hooks';
import { useOnboardingGate } from './hooks/useOnboardingGate.hooks';
import { usePermissions, useQuestions } from './hooks/useParkedPrompts.hooks';
import { usePrLifecycle } from './hooks/usePrLifecycle.hooks';
import { useProjectRegistry } from './hooks/useProjectRegistry.hooks';
import { useProjectRemoval } from './hooks/useProjectRemoval.hooks';
import { useRouting } from './hooks/useRouting.hooks';
import { useSettingsData } from './hooks/useSettingsData.hooks';
import { useSplash } from './hooks/useSplash.hooks';
import { useStableLogCounts } from './hooks/useStableLogCounts.hooks';
import { useWorktreesValue } from './hooks/useWorktreesValue.hooks';

/** The board's live data slice: the task list, selection, derived run counts, and
 *  the per-card badge inputs the Board + its columns + the sidebar read, plus the
 *  three board-owned action handlers (create → NewTaskForm, drag-move → Board, the
 *  confirm-gated column Clear). The ~28 cross-hook handlers behind these live in
 *  `useBoardActions`; the drawer + PR-dialog surfaces are their own slices below. */
export interface BoardData {
  tasks: Task[];
  /** The selected task (drawer subject), or `null` when the drawer is closed. */
  selected: Task | null;
  selectedId: string | null;
  setSelectedId: ReturnType<typeof useBoard>['setSelectedId'];
  anyRunning: boolean;
  /** Concurrently running tasks (`in_progress` + `verifying`) — sidebar footer. */
  runningCount: number;
  /** Streamed log-line counts per task id (running card Logs badge). */
  logCounts: Record<string, number>;
  /** Backend-computed blocked task ids (unfinished dependency). */
  blockedIds: Set<string>;
  /** Task ids with a parked permission prompt OR question (card pulse / needs-input). */
  promptIds: Set<string>;
  handleCreate: BoardActions['handleCreate'];
  handleMoveTask: BoardActions['handleMoveTask'];
  /** Open the destructive bulk-clear confirmation for a column's Clear button. */
  requestClear: BoardActions['confirm']['requestClear'];
}

/** The TaskDetail drawer slice: the selected task's streamed transcript + parked
 *  prompts/questions + gauntlet result, the in-flight-action probe, the close
 *  handler, and the grouped `detailActions` the `TaskActionsProvider` supplies. */
export interface DrawerState {
  streams: Record<string, TaskTranscript>;
  /** Parked permission prompts keyed by task id (`nc:permission`). */
  prompts: Record<string, PermissionPrompt[]>;
  /** Parked AskUserQuestion prompts keyed by task id (`nc:question`). */
  questions: Record<string, QuestionPrompt[]>;
  /** Per-task readiness-gauntlet results, keyed by task id. */
  gauntletResults: Record<string, GauntletResult>;
  /** Task ids with a gauntlet run in flight. */
  gauntletRunning: Set<string>;
  /** True while a guarded task action is in flight (so a button can disable itself). */
  isActionPending: ReturnType<typeof useActionGuard>['isPending'];
  /** Stable "close the detail drawer" handler (clears the selection). */
  closeDetail: () => void;
  /** The drawer's ~25 action callbacks as one referentially stable object, so the
   *  memoized `TaskDetailChrome` bails on a stream flush instead of re-rendering. */
  detailActions: TaskDetailActions;
}

/** The Create PR dialog slice: the guarded push + `gh pr create` mutation, the
 *  open-for task id (`null` = closed), the one-way mount latch, and the close
 *  handler — the human gate opened from the drawer's Create PR button. */
export interface PrDialogState {
  handleCreatePr: CreatePrController['create'];
  prDialogTaskId: CreatePrController['prDialogTaskId'];
  /** True once the dialog has first opened — keeps the lazy chunk mounted so its
   *  close animation can play. */
  prDialogMounted: boolean;
  closePrDialog: CreatePrController['closePrDialog'];
}

/** Everything the shell renders from: the per-domain hook results (routing,
 *  registry, settings, New Project flow) plus the decomposed board surfaces — live
 *  board data, the TaskDetail drawer, and the Create PR dialog — each a small slice
 *  rather than one 60-field controller. */
export interface AppShellState {
  routing: ReturnType<typeof useRouting>;
  registry: ReturnType<typeof useProjectRegistry>;
  settings: ReturnType<typeof useSettingsData>;
  newProject: ReturnType<typeof useNewProjectFlow>;
  /** The board-chrome cluster (appearance override/version + auto-loop) delivered
   *  to the Board and its `BoardHeader` via `BoardChromeProvider`. One shell-memoized
   *  low-churn value: it re-identifies only on a loop event (`nc:loop`), a settings
   *  write, or a project switch — never on a per-frame `nc:session` stream flush. */
  chrome: BoardChromeValue;
  board: BoardData;
  drawer: DrawerState;
  prDialog: PrDialogState;
  /** The shared worktrees slice (list + selection + select/remove/refresh),
   *  memoized in `useWorktreesValue` and provided to the board switcher, the board's
   *  worktree filter, and the standalone WorktreeView via `WorktreesProvider`. */
  worktrees: WorktreesContextValue;
  /** The shared destructive-delete confirmation (card trash + column Clear),
   *  rendered by AppShell as a single `ConfirmDialog`. */
  confirm: BoardActions['confirm'];
  editProject: ReturnType<typeof useEditProject>;
  projectRemoval: ReturnType<typeof useProjectRemoval>;
  onboarding: ReturnType<typeof useOnboardingGate>;
  showSplash: boolean;
  isTauri: boolean;
}

/** The number of concurrently active tasks — `in_progress` + `verifying`. Drives
 *  the sidebar footer's "N running" indicator, which must report the real count
 *  (concurrency defaults to 3), not a boolean coerced to 1/0. */
export function runningTaskCount(tasks: Task[]): number {
  return tasks.filter((t) => isActive(t.status)).length;
}

/** The shell's single composition hook: routing, the project registry, settings,
 *  the New Project flow, and the board's task/stream wiring. Each domain hook lives
 *  in its own `./hooks/*` module; this composes them, delegates the board's cross-
 *  hook actions to `useBoardActions`, the worktrees + chrome context values to
 *  `useWorktreesValue` / `useBoardChromeValue`, and exposes the decomposed
 *  board/drawer/PR-dialog slices. */
export function useAppShell(): AppShellState {
  const toast = useToast();
  // Last-resort net: surface stray promise rejections (fire-and-forget handlers)
  // through the toast channel instead of letting them die in the console.
  useGlobalErrorToast(toast);
  const action = useActionGuard();
  const showSplash = useSplash();
  const routing = useRouting();
  const registry = useProjectRegistry(toast);
  const projectRemoval = useProjectRemoval(registry.projects, registry.remove);
  const onboarding = useOnboardingGate(registry.projects.length);
  const editProject = useEditProject(toast);
  const settings = useSettingsData(toast);
  const persistConcurrency = useCallback(
    (n: number) => settings.update({ maxConcurrency: n }),
    [settings],
  );
  const autoLoop = useAutoLoop(settings.settings?.maxConcurrency ?? 3, persistConcurrency, toast);
  const newProject = useNewProjectFlow(routing.closeNewProject, toast);
  const board = useBoard(toast);
  const blockedIds = useBlockedIds();
  const { tasks, streams, selectedId, setSelectedId } = board;
  const permissions = usePermissions(tasks, toast);
  const questions = useQuestions(tasks, toast);
  const gauntlet = useGauntlet(toast);
  const worktrees = useWorktreesValue(board.reseed, toast);
  const createPr = useCreatePr(action, toast);
  const prLifecycle = usePrLifecycle(action, toast);

  // Latch the Create PR dialog mounted once it first opens. The dialog is a lazy
  // (worktree-chunk) overlay that OWNS its close animation via `<Modal open>`, so it
  // must outlive `prDialogTaskId → null` to animate out. Keying the mount on this
  // one-way latch keeps the chunk loading on demand (first open), not at startup,
  // while letting the dialog stay mounted (rendering nothing when closed).
  const [prDialogMounted, setPrDialogMounted] = useState(false);
  useEffect(() => {
    if (createPr.prDialogTaskId !== null) setPrDialogMounted(true);
  }, [createPr.prDialogTaskId]);

  // The board's cross-hook action layer (the ~28 handlers + the shared destructive
  // confirm + the drawer's `detailActions` memo), extracted so this hook stays a
  // thin router/registry/settings/board-data composition root.
  // Open a task's linked terminal (cockpit spec PR 4, decision 2): flag the session for
  // the Terminal view to activate on mount, then route there. Stable (routing.goto is),
  // so it never churns the memoized detailActions on a stream flush.
  const onOpenTerminal = useCallback(
    (sessionId: string) => {
      requestActivateSession(sessionId);
      routing.goto('terminal');
    },
    [routing.goto],
  );

  const boardActions = useBoardActions({
    board,
    action,
    toast,
    permissions,
    questions,
    gauntlet,
    createPr,
    prLifecycle,
    onOpenTerminal,
  });

  // The real concurrent-run count (tasks default to concurrency 3), not a boolean.
  // The sidebar footer reads this to show "N running"; `anyRunning` is the derived
  // yes/no used for the card pulse, TaskDetail, and the Projects running-dots.
  const runningCount = useMemo(() => runningTaskCount(tasks), [tasks]);
  const anyRunning = runningCount > 0;
  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  // Streamed log-line count per task, for the running card's Logs badge. Its
  // object identity is stabilized on the count VALUES (not the per-delta `streams`
  // map) so text-only deltas don't churn the memoized Board/Column/TaskCard tree.
  const logCounts = useStableLogCounts(streams);

  const promptIds = useMemo(
    () => new Set([...Object.keys(permissions.prompts), ...Object.keys(questions.prompts)]),
    [permissions.prompts, questions.prompts],
  );

  // The low-churn board-chrome cluster (appearance + auto-loop) for the
  // BoardChromeProvider — assembled in its own hook so it re-identifies only on a
  // loop event, a settings write, or a project switch (never on a stream flush).
  const chrome = useBoardChromeValue(registry.active?.id ?? null, settings, autoLoop);

  return {
    routing,
    registry,
    settings,
    newProject,
    chrome,
    board: {
      tasks,
      selected,
      selectedId,
      setSelectedId,
      anyRunning,
      runningCount,
      logCounts,
      blockedIds,
      promptIds,
      handleCreate: boardActions.handleCreate,
      handleMoveTask: boardActions.handleMoveTask,
      requestClear: boardActions.confirm.requestClear,
    },
    drawer: {
      streams,
      prompts: permissions.prompts,
      questions: questions.prompts,
      gauntletResults: gauntlet.results,
      gauntletRunning: gauntlet.running,
      isActionPending: action.isPending,
      closeDetail: boardActions.closeDetail,
      detailActions: boardActions.detailActions,
    },
    prDialog: {
      handleCreatePr: createPr.create,
      prDialogTaskId: createPr.prDialogTaskId,
      prDialogMounted,
      closePrDialog: createPr.closePrDialog,
    },
    worktrees,
    confirm: boardActions.confirm,
    editProject,
    projectRemoval,
    onboarding,
    showSplash,
    isTauri: isTauri(),
  };
}
