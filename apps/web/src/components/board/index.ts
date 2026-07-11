/** Public surface of the board feature: only the symbols the `app` composition
 *  root actually consumes. Everything internal to the board (Column, TaskCard,
 *  the pickers, the prompt cards, the full status vocabulary, …) is reached via
 *  relative paths within `board/` and is intentionally NOT re-exported here. */
export { TaskActionsProvider, type TaskDetailActions } from './actions';
export { Board } from './Board';
export type { PickedBackgroundImage } from './BoardBackgroundPanel';
export { BoardChromeProvider, type BoardChromeValue, type BreakerInfo } from './chrome';
export { NewTaskForm } from './NewTaskForm';
export { EMPTY_TRANSCRIPT, foldTranscript, type TaskTranscript } from './session-stream';
export { COLUMNS, isActive } from './status';
export { TaskDetail } from './TaskDetail';
export {
  hotUsageWindow,
  UsageHotProvider,
  type UsageHotWindow,
  useUsageHot,
} from './usage-hot';
export type { ActiveWorktree } from './WorktreeSwitcher';
