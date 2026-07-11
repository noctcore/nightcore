/** Copy resolution for the {@link TerminalDropHint} overlay — keeps the `.tsx` a thin
 *  shell that never reaches into `terminal-shared` directly (folder-per-component). */
import { dropHintAriaLabel, dropHintLabel } from '../terminal-shared';

/** The drop-hint's visible label + accessible description (round-2 PR C). */
export function useDropHint(): { label: string; ariaLabel: string } {
  return { label: dropHintLabel(), ariaLabel: dropHintAriaLabel() };
}
