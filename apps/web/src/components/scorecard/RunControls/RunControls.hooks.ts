import type { ScorecardDimension } from '@/lib/bridge';
import { useRunConfig as useSharedRunConfig } from '@/lib/useRunConfig';

import { ALL_DIMENSIONS } from '../scorecard.constants';
import type { ScorecardRunConfig } from './RunControls.types';

/**
 * Own the Scorecard run-config: the shared run-config (model/effort + dimension
 * selection) with a `canGrade` alias. Instantiated by the ScorecardView hook (not
 * by `RunControls`) so the state lives ABOVE the form and survives the
 * CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run".
 *
 * @param disabled when true (e.g. no active project), Grade is never permitted.
 */
export function useRunConfig(disabled: boolean): ScorecardRunConfig {
  const base = useSharedRunConfig<ScorecardDimension>(ALL_DIMENSIONS, disabled);
  return { ...base, canGrade: base.canRun };
}
