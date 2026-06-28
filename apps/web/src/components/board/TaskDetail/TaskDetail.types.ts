/** Prop and grouped-action types for the TaskDetail drawer. */
import type {
  GauntletResult,
  PermissionMode,
  PermissionPrompt,
  QuestionAnswer,
  QuestionPrompt,
  RunMode,
  Task,
  TaskKind,
} from '@/lib/bridge';
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
  onClose: () => void;
  /** Every drawer action callback, grouped into one object (see `TaskDetailActions`). */
  actions: TaskDetailActions;
  /** True while a guarded action (`run`/`approve`/`refine`/`reject`/`commit`/
   *  `merge`) is in flight for this task, so the matching footer button disables
   *  itself between the click and the `nc:task` echo. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
}
