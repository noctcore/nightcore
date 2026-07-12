/** Hook that owns the Insight run-config state for the RunControls form. */
import { useState } from 'react';

import type { AnalysisScope, FindingCategory } from '@/lib/bridge';
import { useRunConfig as useSharedRunConfig } from '@/lib/useRunConfig';

import { ALL_CATEGORIES } from '../insight.constants';
import type { InsightRunConfig } from './RunControls.types';

/**
 * Own the Insight run-config: the shared run-config (model/effort/lens selection)
 * plus Insight's repo/diff `scope`. Instantiated by the InsightView hook (not by
 * `RunControls`) so the state lives ABOVE the form and survives the
 * CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on "New run".
 *
 * @param disabled when true (e.g. no active project), Analyze is never permitted.
 */
export function useRunConfig(disabled: boolean): InsightRunConfig {
  const base = useSharedRunConfig<FindingCategory>(ALL_CATEGORIES, disabled);
  const [scope, setScope] = useState<AnalysisScope>('repo');
  const [deep, setDeep] = useState(false);

  return {
    ...base,
    scope,
    setScope,
    deep,
    setDeep,
    canAnalyze: base.canRun,
    prefill: ({ scope: nextScope, model, providerId, categories }) => {
      if (nextScope != null) setScope(nextScope);
      // Deep is a deliberate, session-local opt-in — a "New run" reconfigure always
      // resets it, so a long/expensive deep pass never silently sticks unnoticed.
      setDeep(false);
      base.prefill({ model, providerId, categories });
    },
  };
}
