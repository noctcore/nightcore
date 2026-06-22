import type {
  GauntletResult,
  PermissionMode,
  PermissionPrompt,
  RunMode,
  Task,
  TaskKind,
} from '@/lib/bridge';
import type { SessionStream } from '../session-stream';

export interface TaskDetailProps {
  task: Task;
  stream: SessionStream | undefined;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  /** Parked permission prompts for this task (interactive approval). */
  prompts?: PermissionPrompt[];
  /** The last readiness-gauntlet result for this task (Verified column), or null. */
  gauntlet?: GauntletResult | null;
  /** True while a gauntlet run is in flight for this task. */
  gauntletRunning?: boolean;
  onClose: () => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Answer a parked permission prompt. */
  onRespondPermission?: (taskId: string, requestId: string, decision: 'allow' | 'deny') => void;
  /** Plan-approval actions (shown for a plan-parked `waiting_approval`). */
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onRefine?: (id: string) => void;
  /** Edit the task's kind (M4) — only when the task hasn't run yet. */
  onChangeKind?: (id: string, kind: TaskKind) => void;
  /** Edit the task's run mode (M4.6) — only when the task hasn't run yet. */
  onChangeRunMode?: (id: string, runMode: RunMode) => void;
  /** Edit the task's permission-mode override (M4.7) — `null` = inherit. Pre-run. */
  onChangePermissionMode?: (id: string, permissionMode: PermissionMode | null) => void;
  /** Edit the task's model override (M4.7) — `null` = inherit. Pre-run. */
  onChangeModel?: (id: string, model: string | null) => void;
  /** Edit the task's reasoning-effort override (M4.7) — `null` = inherit. Pre-run. */
  onChangeEffort?: (id: string, effort: string | null) => void;
  /** Edit the task's max-turns ceiling (SDK guardrail) — `null` = inherit. Pre-run. */
  onChangeMaxTurns?: (id: string, maxTurns: number | null) => void;
  /** Edit the task's max-budget-USD ceiling (SDK guardrail) — `null` = inherit. Pre-run. */
  onChangeMaxBudget?: (id: string, maxBudgetUsd: number | null) => void;
  /** Verification-approval actions for a review-parked `waiting_approval` (M4). */
  onAcceptReview?: (id: string) => void;
  onRejectReview?: (id: string) => void;
  onRerunVerification?: (id: string) => void;
  /** Run the pre-merge readiness gauntlet (Verified column "Run checks"). */
  onRunGauntlet?: (id: string) => void;
  /** Merge a verified task's branch (gated on `verified && gauntlet.passed`). */
  onMerge?: (id: string) => void;
  /** Commit a verified task's worktree. */
  onCommit?: (id: string) => void;
  /** True while a guarded action (`run`/`approve`/`refine`/`reject`/`commit`/
   *  `merge`) is in flight for this task, so the matching footer button disables
   *  itself between the click and the `nc:task` echo. Defaults to never-pending. */
  isActionPending?: (action: string, id: string) => boolean;
}
