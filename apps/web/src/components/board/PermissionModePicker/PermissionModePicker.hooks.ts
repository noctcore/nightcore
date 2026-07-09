import type { AutonomyLevel, PermissionMode } from '@/lib/bridge';

import type { PermissionModeOption } from '../status';
import { PERMISSION_MODE_OPTIONS } from '../status';

/** The hint shown beneath the selector for the active choice (or the inherit
 *  explainer when `null`). Pure — keeps the lookup out of the component body. */
export function permissionModeHint(value: PermissionMode | null): string {
  if (value === null) {
    return 'Inherits the project / global default (Bypass unless overridden).';
  }
  return PERMISSION_MODE_OPTIONS.find((option) => option.mode === value)?.hint ?? '';
}

export function supportedPermissionOptions(
  supportedAutonomyLevels: AutonomyLevel[] | undefined,
): PermissionModeOption[] {
  if (supportedAutonomyLevels === undefined) return PERMISSION_MODE_OPTIONS;
  const supported = new Set<AutonomyLevel>(supportedAutonomyLevels);
  return PERMISSION_MODE_OPTIONS.filter((option) => supported.has(option.mode));
}

export function normalizedPermissionValue(
  value: PermissionMode | null,
  supportedAutonomyLevels: AutonomyLevel[] | undefined,
): PermissionMode | null {
  if (value === null || supportedAutonomyLevels === undefined) return value;
  return supportedAutonomyLevels.includes(value) ? value : null;
}
