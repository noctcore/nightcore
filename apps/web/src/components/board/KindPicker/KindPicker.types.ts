/** Props for the KindPicker component. */
import type { TaskKind } from '@/lib/bridge';

/** Props for the task-kind picker: the selected kind, the change handler, and
 *  compact/disabled layout flags. */
export interface KindPickerProps {
  /** The currently selected kind. */
  value: TaskKind;
  /** Fired when the user picks a selectable (enabled) kind. */
  onChange: (kind: TaskKind) => void;
  /** When true, render a compact inline row (used in the detail panel). */
  compact?: boolean;
  /** Disable the whole control (e.g. once a task has started running). */
  disabled?: boolean;
}
