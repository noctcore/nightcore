import type { ConventionCategory } from '@/lib/bridge';
import { ALL_CATEGORIES } from '../harness.constants';
import type { RunControlsProps } from './RunControls.types';

export interface RunControlsView {
  /** The selected lenses in canonical display order (sent on Scan). */
  orderedSelected: ConventionCategory[];
  /** Whether the Scan action is currently permitted. */
  canScan: boolean;
}

/** Pure derivation over the lifted config props: the canonical-ordered selection
 *  and the Scan gate. Form state itself lives in the HarnessView hook (lifted so it
 *  survives the CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on a new
 *  run), so this component is fully controlled. */
export function useRunControls({
  selected,
  isStarting,
  disabled,
}: RunControlsProps): RunControlsView {
  const orderedSelected = ALL_CATEGORIES.filter((c) => selected.has(c));
  const canScan = !disabled && !isStarting && orderedSelected.length > 0;
  return { orderedSelected, canScan };
}
