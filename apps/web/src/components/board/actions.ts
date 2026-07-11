/** The board's shared task-action seam: the grouped action callbacks the shell
 *  owns, delivered to the TaskDetail drawer subtree through context instead of
 *  being threaded `TaskDetail` → `TaskDetailChrome` → eight leaves as props.
 *
 *  The provider value MUST stay referentially stable across `nc:session` stream
 *  flushes — the shell assembles it once from individually memoized handlers
 *  (`useAppShell`'s `detailActions`), so providing it through context is free:
 *  consumers re-render only when a real input changes (a parked prompt resolving,
 *  the action-guard's pending set transitioning), never on a per-frame delta.
 *  VOLATILITY RULE: nothing whose value changes on a stream flush (task streams,
 *  raw log counts) may ever enter this context — the fast-changing stream travels
 *  through `TaskStreamContext` instead. */
import { createContext, createElement, type ReactNode, useContext } from 'react';

import type {
  PermissionMode,
  QuestionAnswer,
  RunMode,
  TaskKind,
} from '@/lib/bridge';

/** The drawer's action callbacks, grouped into one object so the ~25 `on*`
 *  handlers travel as a single context value instead of being threaded
 *  individually through `TaskDetail` and its sub-components. Assembled once at
 *  the AppShell call site from the `board` controller. Each handler is optional —
 *  the drawer degrades the matching control to a no-op / hidden state when one is
 *  absent (e.g. the History section only renders once resume/rename/tag are wired). */
export interface TaskDetailActions {
  /** Open a task: select it on the board and open its detail drawer. The shell
   *  wires the (stable) selection setter, so this never churns on a flush. */
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Answer a parked permission prompt. */
  onRespondPermission?: (taskId: string, requestId: string, decision: 'allow' | 'deny') => void;
  /** Answer a parked AskUserQuestion prompt (submit choices or skip). */
  onAnswerQuestion?: (taskId: string, requestId: string, answer: QuestionAnswer) => void;
  /** Plan-approval actions (shown for a plan-parked `waiting_approval`). */
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onRefine?: (id: string) => void;
  /** Edit the task's kind — only when the task hasn't run yet. */
  onChangeKind?: (id: string, kind: TaskKind) => void;
  /** Edit the task's run mode — only when the task hasn't run yet. */
  onChangeRunMode?: (id: string, runMode: RunMode) => void;
  /** Edit the task's permission-mode override — `null` = inherit. Pre-run. */
  onChangePermissionMode?: (id: string, permissionMode: PermissionMode | null) => void;
  /** Edit the task's model override — `null` = inherit. Pre-run. */
  onChangeModel?: (id: string, model: string | null) => void;
  /** Edit the task's model-provider stamp (B5) so an edited selection round-trips
   *  its provider. `undefined` = absent/derive-from-id. Pre-run, set with the model. */
  onChangeProvider?: (id: string, providerId: string | undefined) => void;
  /** Edit the task's reasoning-effort override — `null` = inherit. Pre-run. */
  onChangeEffort?: (id: string, effort: string | null) => void;
  /** Edit the task's max-turns ceiling (SDK guardrail) — `null` = inherit. Pre-run. */
  onChangeMaxTurns?: (id: string, maxTurns: number | null) => void;
  /** Edit the task's max-budget-USD ceiling (SDK guardrail) — `null` = inherit. Pre-run. */
  onChangeMaxBudget?: (id: string, maxBudgetUsd: number | null) => void;
  /** Verification-approval actions for a review-parked `waiting_approval`. */
  onAcceptReview?: (id: string) => void;
  onRejectReview?: (id: string) => void;
  onRerunVerification?: (id: string) => void;
  /** Run the pre-merge readiness gauntlet (Verified column "Run checks"). */
  onRunGauntlet?: (id: string) => void;
  /** Convert one proposed sub-task of a decompose task into a board
   *  task. Enables the per-row Convert button in the Proposed sub-tasks panel. */
  onConvertSubtask?: (parentId: string, subtaskId: string) => void;
  /** Convert every still-open proposed sub-task at once. */
  onConvertAllSubtasks?: (parentId: string) => void;
  /** Merge a verified task's branch (gated on `verified && gauntlet.passed`). */
  onMerge?: (id: string) => void;
  /** Commit a verified task's worktree. */
  onCommit?: (id: string) => void;
  /** Open the Create PR dialog (the human gate) for an eligible task — shown
   *  beside Merge when the full PR eligibility contract holds. */
  onCreatePr?: (id: string) => void;
  /** Open a created pull request in the system browser (the `PR #<n>` chip). */
  onOpenPr?: (url: string) => void;
  /** Re-push the task branch to an open PR (the status card's Push updates).
   *  Promise-returning so the card can refetch the status on success. Guarded
   *  under the `pushPrUpdates` pending key. */
  onPushPrUpdates?: (id: string) => Promise<void>;
  /** Finalize a REMOTE-merged PR: mark the task merged locally + honor the
   *  cleanup setting (`finalizePr` pending key). The task echo updates the board. */
  onFinalizePr?: (id: string) => Promise<void>;
  /** Fast-forward-only pull of the base branch on the project root after a
   *  remote merge (`pullBaseFf` pending key). */
  onPullBaseFf?: (id: string) => Promise<void>;
  /** Dispatch the fix run that addresses the PR's review comments — re-fetched
   *  server-side and fenced as UNTRUSTED input (`addressPrComments` pending key).
   *  The task echo flips it to in_progress. */
  onAddressPrComments?: (id: string) => Promise<void>;
  /** Resume a chosen historical session — relaunches the task pointed at the UUID
   *  (refused Rust-side for an orphaned session). Enables the History section. */
  onResumeSession?: (taskId: string, sdkSessionId: string) => void;
  /** Rename a past session's title. */
  onRenameSession?: (sdkSessionId: string, title: string) => void;
  /** Tag a past session, or clear its tag with `null`. */
  onTagSession?: (sdkSessionId: string, tag: string | null) => void;
  /** Open the terminal linked to a task (cockpit spec PR 4, decision 2): route to the
   *  Terminal view and activate the given session's tab. Enables the card's terminal
   *  chip. */
  onOpenTerminal?: (sessionId: string) => void;
  /** True while a guarded action (`run`/`approve`/`commit`/…) is in flight for
   *  the task, so the matching button disables itself between the click and the
   *  `nc:task` echo. Identity turns over only when the guard's pending set
   *  transitions (a click starting/settling) — never on a stream flush — so it
   *  is volatility-safe in this context. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
}

/** Carries the shell's grouped task actions to the TaskDetail drawer subtree.
 *  `null` means "no provider above" — {@link useTaskActions} throws rather than
 *  silently rendering dead controls. */
export const TaskActionsContext = createContext<TaskDetailActions | null>(null);

/** Provide the shell's (referentially stable) grouped task actions to a subtree.
 *  A plain-`.ts` provider (feature-root module, not a component folder), so it
 *  renders via `createElement` rather than JSX. */
export function TaskActionsProvider({
  actions,
  children,
}: {
  actions: TaskDetailActions;
  children: ReactNode;
}) {
  return createElement(TaskActionsContext.Provider, { value: actions }, children);
}

/** Read the shell's grouped task actions. Throws outside a provider so a missing
 *  wiring fails loudly in dev/test instead of shipping inert buttons. */
export function useTaskActions(): TaskDetailActions {
  const actions = useContext(TaskActionsContext);
  if (actions === null) {
    throw new Error('useTaskActions must be used within a <TaskActionsProvider>.');
  }
  return actions;
}
