/** Props for the PermissionModePicker component. */
import type { AutonomyLevel, PermissionMode } from '@/lib/bridge';

/** Props for the permission-mode picker: the current override (`null` = inherit),
 *  the change handler, and a disabled flag. */
export interface PermissionModePickerProps {
  /** The current override, or `null` to inherit the project/global default. */
  value: PermissionMode | null;
  /** Fired when the user picks a mode, or the Inherit option (`null`). */
  onChange: (value: PermissionMode | null) => void;
  /** Disable the whole control (e.g. once a task has started running). */
  disabled?: boolean;
  /** Supported autonomy levels from the selected provider; absent = fail-open. */
  supportedAutonomyLevels?: AutonomyLevel[];
}
