/** BoardHeader-local disclosure hooks: the provider-config inspector and the
 *  Board Background settings sheet. Both moved here from the Board's hooks with
 *  the header extraction — each header button owns its own toggle; the panels
 *  are self-contained fixed-overlay sheets. */
import { useDisclosure } from '../Board/Board.hooks';

/** Open/close state for the read-only provider-config inspector. */
export function useInspector(): { open: boolean; show: () => void; hide: () => void } {
  return useDisclosure();
}

/** Open/close state for the Board Background settings sheet (same disclosure
 *  shape as the inspector). */
export function useBoardBackgroundPanel(): { open: boolean; show: () => void; hide: () => void } {
  return useDisclosure();
}
