/** Prop types for the InteractionDock. The permission/question relay handlers
 *  come from `TaskActionsContext` (`onRespondPermission` / `onAnswerQuestion`),
 *  not props. */
import type { PermissionPrompt, QuestionPrompt } from '@/lib/bridge';

export interface InteractionDockProps {
  /** The task whose parked interactions this dock surfaces. */
  taskId: string;
  /** Parked permission prompts for the task (interactive allow/deny). */
  permissionPrompts: PermissionPrompt[];
  /** Parked AskUserQuestion prompts for the task (pick/answer). */
  questionPrompts: QuestionPrompt[];
}
