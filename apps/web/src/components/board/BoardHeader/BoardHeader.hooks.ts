/** BoardHeader-local disclosure hooks: the provider-config inspector and the
 *  Board Background settings sheet. Both moved here from the Board's hooks with
 *  the header extraction — each header button owns its own toggle; the panels
 *  are self-contained fixed-overlay sheets. */
import { useDisclosure } from '../Board/Board.hooks';
import { armPreview, useRunOrder } from '../run-order';

/** Open/close state for the read-only provider-config inspector. */
export function useInspector(): { open: boolean; show: () => void; hide: () => void } {
  return useDisclosure();
}

/** Open/close state for the Board Background settings sheet (same disclosure
 *  shape as the inspector). */
export function useBoardBackgroundPanel(): { open: boolean; show: () => void; hide: () => void } {
  return useDisclosure();
}

/** Open/close state for the Run order sheet (#402) — same disclosure shape as the
 *  inspector and the background panel. */
export function useRunOrderSheet(): { open: boolean; show: () => void; hide: () => void } {
  return useDisclosure();
}

/** The Auto Mode toggle's title (#402): the arm PREVIEW while disarmed, so hovering the
 *  toggle already answers "how many runs will this start?" without opening the popover.
 *  Armed, it reverts to the plain stop hint (the preview then describes what the running
 *  loop will pick up next, which the popover shows). Reads the SAME `armPreview`
 *  derivation the popover does, so the two can never disagree. */
export function useAutoModeToggleTitle(autoMode: boolean): string {
  const preview = armPreview(useRunOrder());
  if (autoMode) return 'Stop Auto Mode';
  return `Start Auto Mode — ${preview.summary.toLowerCase()}`;
}
