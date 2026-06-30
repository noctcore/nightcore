/** DiscardDialog helpers: pure derivations for the dialog's affordances. The
 *  component is stateless (all data arrives via props), so these are plain
 *  functions, not `use*` hooks. */
import type { DiscardDialogProps } from './DiscardDialog.types';

/** Whether the error slot carries a real message. When true the discard has
 *  already failed once, so the confirm action becomes a retry. */
export function hasDiscardError(error: DiscardDialogProps['error']): boolean {
  return error != null && error !== '';
}

/** Whether the amber data-loss warning should show (uncommitted work present). */
export function hasUncommittedChanges(
  changedFiles: DiscardDialogProps['changedFiles'],
): boolean {
  return changedFiles !== undefined && changedFiles > 0;
}

/** The confirm button's resting label: "Retry" after a failed attempt, else
 *  "Discard". The in-flight spinner label is rendered by the view. */
export function discardConfirmLabel(
  error: DiscardDialogProps['error'],
): 'Discard' | 'Retry' {
  return hasDiscardError(error) ? 'Retry' : 'Discard';
}
