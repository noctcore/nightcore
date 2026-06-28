import type { ScorecardDimension } from '@/lib/bridge';
import type { RunConfig, RunConfigPrefill } from '@/lib/useRunConfig';

/** Scorecard pre-fill is just the shared shape over the dimension vocabulary. */
export type ScorecardRunConfigPrefill = RunConfigPrefill<ScorecardDimension>;

/**
 * The lifted Scorecard run-config: the shared {@link RunConfig} (model/effort +
 * dimension selection) with a `canGrade` alias for the Grade CTA. Owned by the
 * ScorecardView hook (via `useRunConfig`) so it survives the CONFIGURE → RUNNING →
 * RESULTS phase swaps and pre-fills on a new run. Unlike Insight there is no
 * repo/diff scope (readiness is always graded repo-wide).
 */
export interface ScorecardRunConfig
  extends RunConfig<ScorecardDimension> {
  /** Alias of `canRun`, kept for the Grade CTA's readability. */
  canGrade: boolean;
}

/** Props for the RunControls CONFIGURE form: the lifted config, a starting flag, and the Grade action. */
export interface RunControlsProps {
  /** The lifted form state, owned by the ScorecardView hook. */
  config: ScorecardRunConfig;
  /** True between the Grade click and the optimistic running swap. */
  isStarting: boolean;
  /** Start a run with the current config. */
  onGrade: () => void;
}
