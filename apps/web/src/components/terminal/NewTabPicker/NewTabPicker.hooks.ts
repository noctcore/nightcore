/** NewTabPicker helpers: pure derivations for the picker's affordances. The
 *  component is stateless (all data arrives via props), so these are plain
 *  functions, not `use*` hooks. */
import type { NewTabPickerProps, TerminalTarget } from './NewTabPicker.types';

/** Whether the picker has any openable target (else it shows an empty note). */
export function hasTargets(targets: TerminalTarget[]): boolean {
  return targets.length > 0;
}

/** Whether a real spawn error is present (drives the inline red notice). */
export function hasPickerError(error: NewTabPickerProps['error']): boolean {
  return error != null && error !== '';
}
