import type { PermissionMode } from '@/lib/bridge';

export interface PermissionModePickerProps {
  /** The current override, or `null` to inherit the project/global default. */
  value: PermissionMode | null;
  /** Fired when the user picks a mode, or the Inherit option (`null`). */
  onChange: (value: PermissionMode | null) => void;
  /** Disable the whole control (e.g. once a task has started running). */
  disabled?: boolean;
}
