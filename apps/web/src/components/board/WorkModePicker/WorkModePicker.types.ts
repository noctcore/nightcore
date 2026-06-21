import type { RunMode } from '@/lib/bridge';

export interface WorkModePickerProps {
  /** The currently selected run mode. */
  value: RunMode;
  /** Fired when the user picks a mode. */
  onChange: (mode: RunMode) => void;
  /** Disable the whole control (e.g. once a task has started running — run mode
   *  is not editable mid-run). */
  disabled?: boolean;
}
