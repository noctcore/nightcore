/** Props for the WorkModePicker component. */
import type { RunMode } from '@/lib/bridge';

/** Props for the run-mode picker: the selected mode, the change handler, and a
 *  disabled flag for mid-run tasks. */
export interface WorkModePickerProps {
  /** The currently selected run mode. */
  value: RunMode;
  /** Fired when the user picks a mode. */
  onChange: (mode: RunMode) => void;
  /** Disable the whole control (e.g. once a task has started running — run mode
   *  is not editable mid-run). */
  disabled?: boolean;
}
