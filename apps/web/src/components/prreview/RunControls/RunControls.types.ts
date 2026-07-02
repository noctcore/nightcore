/** Types for the PR Review run-config (lifted form state) and RunControls props. */
import type { ReviewLens } from '@/lib/bridge';
import type { RunConfig, RunConfigPrefill } from '@/lib/useRunConfig';

/** PR Review pre-fill adds the PR number on top of the shared shape. */
export interface PrReviewRunConfigPrefill extends RunConfigPrefill<ReviewLens> {
  prNumber?: number | null;
}

/**
 * The lifted PR Review run-config: the shared {@link RunConfig} (model/effort/lens
 * selection) plus the PR number that is PR-review-specific. Owned by the
 * PrReviewView hook (via `useRunConfig`) so it survives the CONFIGURE → RUNNING →
 * RESULTS phase swaps and pre-fills on a new run. `RunControls` is a controlled,
 * purely-presentational form that renders this.
 */
export interface PrReviewRunConfig
  extends Omit<RunConfig<ReviewLens>, 'prefill'> {
  /** The raw PR-number input (controlled; may be empty/invalid mid-type). */
  prNumber: string;
  setPrNumber: (value: string) => void;
  /** The parsed positive-integer PR number, or `null` when empty/invalid. */
  prNumberValue: number | null;
  /** Whether the PR-number input is a valid positive integer. */
  prNumberValid: boolean;
  /** Whether the run action is permitted (valid pr# + ≥1 lens, not disabled). */
  canReview: boolean;
  prefill: (opts: PrReviewRunConfigPrefill) => void;
}

/** Props for the RunControls form. */
export interface RunControlsProps {
  /** The lifted form state, owned by the PrReviewView hook. */
  config: PrReviewRunConfig;
  /** True between the Review click and the optimistic running swap. */
  isStarting: boolean;
  /** Start a run with the current config. */
  onReview: () => void;
}
