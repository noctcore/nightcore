import type { PermissionMode } from '@/lib/bridge';
import { PERMISSION_MODE_OPTIONS } from '../status';

/** The hint shown beneath the selector for the active choice (or the inherit
 *  explainer when `null`). Pure — keeps the lookup out of the component body. */
export function permissionModeHint(value: PermissionMode | null): string {
  if (value === null) {
    return 'Inherits the project / global default (Bypass unless overridden).';
  }
  return PERMISSION_MODE_OPTIONS.find((option) => option.mode === value)?.hint ?? '';
}
