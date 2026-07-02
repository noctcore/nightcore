/** Prop and grouped-action types for the TaskDetail drawer. */
import type {
  GauntletResult,
  PermissionMode,
  PermissionPrompt,
  PrReviewComments,
  PrStatus,
  PrSupport,
  QuestionAnswer,
  QuestionPrompt,
  RunMode,
  Task,
  TaskKind,
} from '@/lib/bridge';

import type { PrReviewCommentsView } from '../PrReviewComments';
import type { PrStatusView } from '../PrStatusCard';
import type { TaskTranscript } from '../session-stream';

/** The drawer's action callbacks, grouped into one object so the ~25 `on*`
 *  handlers travel as a single prop instead of being threaded individually
 *  through `TaskDetail` and its sub-components. Assembled once at the AppShell
 *  call site from the `board` controller. Each handler is optional — the drawer
 *  degrades the matching control to a no-op / hidden state when one is absent
 *  (e.g. the History section only renders once resume/rename/tag are wired). */
export interface TaskDetailActions {
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
}

/** Props for the TaskDetail drawer: the task, its live transcript, parked
 *  prompts, gauntlet state, and the grouped action callbacks. */
export interface TaskDetailProps {
  task: Task;
  stream: TaskTranscript | undefined;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  /** Parked permission prompts for this task (interactive approval). */
  prompts?: PermissionPrompt[];
  /** Parked AskUserQuestion prompts for this task (interactive answer). */
  questions?: QuestionPrompt[];
  /** The last readiness-gauntlet result for this task (Verified column), or null. */
  gauntlet?: GauntletResult | null;
  /** True while a gauntlet run is in flight for this task. */
  gauntletRunning?: boolean;
  /** Story/test override for the PR capability probe. When provided (including
   *  `null`), the drawer's lazy `pr_support` fetch is skipped and this value
   *  gates the Create PR button directly; omit it (the app shell does) to let
   *  `usePrSupport` probe lazily per task id. */
  prSupport?: PrSupport | null;
  /** Story/test override for the PR status card. When provided (including
   *  `null`), the card's fetch-on-mount is skipped and this value renders
   *  directly; omit it (the app shell does) to let the card fetch lazily. */
  prStatus?: PrStatus | null;
  /** Story/test override for the Review comments card. When provided (including
   *  `null`), the section's fetch-on-mount is skipped and this payload renders
   *  directly (`null` ⇒ the unavailable note); omit it (the app shell does) to
   *  let the section fetch lazily. */
  prReviewComments?: PrReviewComments | null;
  onClose: () => void;
  /** Every drawer action callback, grouped into one object (see `TaskDetailActions`). */
  actions: TaskDetailActions;
  /** True while a guarded action (`run`/`approve`/`refine`/`reject`/`commit`/
   *  `merge`) is in flight for this task, so the matching footer button disables
   *  itself between the click and the `nc:task` echo. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
  /** Navigate to the scan item this task was converted from (the provenance
   *  chip's click). A routing concern, so it travels beside `onClose` rather
   *  than in the board-action group; absent ⇒ the chip renders inert. */
  onOpenSourceRef?: (sourceRef: string) => void;
}

/** Props for the memoized `TaskDetailChrome` — the static drawer shell around the
 *  live activity timeline. It takes the already-derived view scalars (never the
 *  per-frame `stream`) so a stream flush that re-renders the outer `TaskDetail`
 *  bails out here; only the context-fed `<ActivityLog>` re-renders. The memo bails
 *  because nothing here turns over on a high-frequency `nc:session` flush: the
 *  scalars (`cost`, the booleans) are passed by value, so the shallow compare
 *  matches until they actually change — `cost` only at a session boundary
 *  (`session-completed` carries the cost; text-delta flushes leave it null), the
 *  booleans only on a `task.status` transition. The callback props are stable
 *  refs — `onClose`/`isActionPending` are memoized, and the grouped `actions`
 *  object stays stable ONLY because `useActionGuard` returns a memoized `action`
 *  (an unmemoized one would re-identify every guarded handler each render and
 *  defeat this memo). The one prop that does change every frame — the stream — is
 *  deliberately absent; it reaches `<ActivityLog>` via `TaskStreamContext`. */
export interface TaskDetailChromeProps {
  task: Task;
  /** Aggregate run cost — live stream total, falling back to the persisted total. */
  cost: number | null;
  /** True while the task's build session is streaming (`in_progress`). */
  isRunning: boolean;
  /** A `waiting_approval` parked on a verification verdict (has `review`). */
  reviewParked: boolean;
  /** A `waiting_approval` parked on a plan (`ExitPlanMode`, no verdict yet). */
  planParked: boolean;
  /** Whether the kind picker is editable — only before the task has run. */
  kindEditable: boolean;
  /** Whether the Done-column gauntlet + merge controls apply (a `done` task). */
  isDoneColumn: boolean;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  prompts: PermissionPrompt[];
  questions: QuestionPrompt[];
  gauntlet: GauntletResult | null;
  gauntletRunning: boolean;
  /** The resolved PR capability probe for this task (`null` = unknown/red —
   *  the Create PR button hides). Resolved by the outer drawer's `usePrSupport`
   *  so this memoized chrome stays hook-free. */
  prSupport: PrSupport | null;
  /** The LIFTED PR-status view, resolved by the outer drawer's `usePrStatus`
   *  (fetch once `task.prUrl` exists; the `prStatus` prop overrides for
   *  stories/tests). Shared by the status card (which renders it) and the
   *  footer (Merge disables when the fetched state is MERGED). Memoized by the
   *  hook, so this memo still bails on stream flushes. */
  prStatusView: PrStatusView;
  /** The LIFTED PR review-comments view, resolved by the outer drawer's
   *  `usePrReviewComments` (fetches once `task.prUrl` exists; outside Tauri it
   *  resolves an empty payload → the quiet empty note). Rendered by the read-only
   *  Review comments card below the PR status band. Memoized by the hook, so this
   *  memo still bails on stream flushes. */
  prReviewCommentsView: PrReviewCommentsView;
  onClose: () => void;
  actions: TaskDetailActions;
  isActionPending?: (action: string, id: string) => boolean;
  onOpenSourceRef?: (sourceRef: string) => void;
}
