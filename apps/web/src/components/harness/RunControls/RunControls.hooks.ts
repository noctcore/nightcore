import type { ConventionCategory } from '@/lib/bridge';
import {
  useRunConfig as useSharedRunConfig,
  type RunConfig,
} from '@/lib/useRunConfig';
import { ALL_CATEGORIES } from '../harness.constants';

/**
 * Own the Harness run-config: the shared run-config (model/effort/lens selection)
 * bound to the convention lenses. Instantiated by the HarnessView hook (not by
 * `RunControls`) so the state lives ABOVE the form and survives the
 * CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run". Harness
 * always scans the whole repo, so unlike Insight there is no `scope` to add.
 *
 * @param disabled when true (e.g. no active project), Scan is never permitted.
 */
export function useRunConfig(disabled: boolean): RunConfig<ConventionCategory> {
  return useSharedRunConfig<ConventionCategory>(ALL_CATEGORIES, disabled);
}
