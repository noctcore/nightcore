import type { AnalysisScope, FindingCategory } from '@/lib/bridge';
import type { RunConfig, RunConfigPrefill } from '@/lib/useRunConfig';

/** Insight pre-fill adds the repo/diff scope on top of the shared shape. */
export interface InsightRunConfigPrefill extends RunConfigPrefill<FindingCategory> {
  scope?: AnalysisScope | null;
}

/**
 * The lifted Insight run-config: the shared {@link RunConfig} (model/effort/lens
 * selection) plus the repo/diff `scope` that is Insight-specific. Owned by the
 * InsightView hook (via `useRunConfig`) so it survives the CONFIGURE → RUNNING →
 * RESULTS phase swaps and pre-fills on a new run. `RunControls` is a controlled,
 * purely-presentational form that renders this.
 */
export interface InsightRunConfig
  extends Omit<RunConfig<FindingCategory>, 'prefill'> {
  scope: AnalysisScope;
  setScope: (scope: AnalysisScope) => void;
  /** Alias of `canRun`, kept for the Analyze CTA's readability. */
  canAnalyze: boolean;
  prefill: (opts: InsightRunConfigPrefill) => void;
}

export interface RunControlsProps {
  /** The lifted form state, owned by the InsightView hook. */
  config: InsightRunConfig;
  /** True between the Analyze click and the optimistic running swap. */
  isStarting: boolean;
  /** Start a run with the current config. */
  onAnalyze: () => void;
}
