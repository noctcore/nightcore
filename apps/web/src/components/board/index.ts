/** Public surface of the board feature: components, the status vocabulary, and
 *  the session-stream folding helpers. */
export {
  TaskActionsContext,
  TaskActionsProvider,
  type TaskDetailActions,
  useTaskActions,
} from './actions';
export type { AutoModeOptionsProps } from './AutoModeOptions';
export { AutoModeOptions } from './AutoModeOptions';
export { Board } from './Board';
export type { PickedBackgroundImage } from './BoardBackgroundPanel';
export { BoardDnd } from './BoardDnd';
export {
  BoardChromeContext,
  BoardChromeProvider,
  type BoardChromeValue,
  type BreakerInfo,
  useBoardChrome,
} from './chrome';
export { Column } from './Column';
export { GauntletResults } from './GauntletResults';
export { InteractionDock } from './InteractionDock';
export { KindPicker } from './KindPicker';
export { NewTaskForm } from './NewTaskForm';
export { PermissionModePicker } from './PermissionModePicker';
export { PermissionPrompt } from './PermissionPrompt';
export type { ProviderConfigData,ProviderConfigPanelProps } from './ProviderConfigPanel';
export { ProviderConfigPanel } from './ProviderConfigPanel';
export type { PrReviewCommentsProps } from './PrReviewComments';
export { PrReviewComments } from './PrReviewComments';
export type { PrStatusCardProps } from './PrStatusCard';
export { PrStatusCard } from './PrStatusCard';
export { QuestionPrompt } from './QuestionPrompt';
export { ReviewPanel } from './ReviewPanel';
export {
  EMPTY_STREAM,
  EMPTY_TRANSCRIPT,
  foldSession,
  foldTranscript,
  type SessionGroup,
  type SessionPhase,
  type SessionStream,
  type TaskTranscript,
  type TextEntry,
  type TimelineEntry,
  type ToolEntry,
} from './session-stream';
export type { SessionHistoryData,SessionHistoryProps } from './SessionHistory';
export { SessionHistory } from './SessionHistory';
export {
  type ColumnDef,
  COLUMNS,
  EFFORT_OPTIONS,
  type EffortOption,
  formatCost,
  isActive,
  KIND_LABEL,
  KIND_OPTIONS,
  type KindOption,
  MODEL_OPTIONS,
  modelDisplayName,
  modelDotColor,
  type ModelOption,
  parseVerdict,
  PERMISSION_MODE_LABEL,
  PERMISSION_MODE_OPTIONS,
  type PermissionModeOption,
  RUN_MODE_LABEL,
  RUN_MODE_OPTIONS,
  type RunModeOption,
  STATUS_DOT_COLOR,
  STATUS_LABEL,
  STATUS_TEXT,
  type Verdict,
  VERDICT_LABEL,
  VERDICT_TEXT,
} from './status';
export { TaskCard } from './TaskCard';
export { TaskDetail } from './TaskDetail';
export { TaskStatusDot } from './TaskStatusDot';
export { WorkModePicker } from './WorkModePicker';
export type { ActiveWorktree, WorktreeTab } from './WorktreeSwitcher';
export { filterTasksByWorktree,WorktreeSwitcher } from './WorktreeSwitcher';
