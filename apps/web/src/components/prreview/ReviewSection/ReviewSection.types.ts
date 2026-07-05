/** Types for the PR Review workspace's REVIEW SECTION — the per-PR run area
 *  (config → running → results) driven by the run registry's `byPr` slice. All
 *  state lives in the PrReviewView view model; the section is a controlled,
 *  purely-presentational composition. */
import type { MenuItem, RunProgressCategory } from '@/components/ui';
import type { ReviewLens } from '@/lib/bridge';
import type { RunConfig } from '@/lib/useRunConfig';

import type { FixRunCardProps } from '../FixRunCard';
import type { ReviewFindingView, ReviewVerdict } from '../prreview.types';
import type { TimelineStep } from '../prreview-lifecycle';
import type { ReviewStream } from '../prreview-stream';
import type { ReviewPositionData } from '../ReviewPosition';

/** Which of the three per-PR run states the section renders. */
export type ReviewSectionMode = 'config' | 'running' | 'results';

/** The CONFIG state: lens chips + model/effort + the Review action. */
export interface ReviewSectionConfigSlice {
  /** The lifted lens/model/effort form state (shared `RunConfig`). */
  config: RunConfig<ReviewLens>;
  /** True between the Review click and the optimistic running entry. */
  isStarting: boolean;
  /** This PR's last start rejection (per-PR, from the registry), or null. */
  startError: string | null;
  /** Start a review of this PR with the current config. */
  onReview: () => void;
  /** Leave a "New review" reconfigure back to the existing results, or `null`
   *  when there are no results to return to (config is the natural state). */
  onBackToResults: (() => void) | null;
}

/** The RUNNING state: compact per-lens progress + per-run cancel. */
export interface ReviewSectionRunningSlice {
  /** The requested lenses as ordered RunProgress descriptors. */
  categories: RunProgressCategory[];
  /** Total findings produced per lens so far. */
  findingCounts: Record<string, number>;
  /** Cancel THIS run (a no-op while the run id is still unknown). */
  onCancel: () => void;
}

/** The completed-run toolbar: convert-all + selection + the verdict gate. */
export interface ReviewSectionToolbarSlice {
  openCount: number;
  onConvertAll: () => void;
  bulkConverting: boolean;
  bulkProgress: { done: number; total: number; failed: number };
  bulkStatusMessage: string;
  bulkError: string | null;
  /** Selected (postable) findings count. */
  selectedCount: number;
  /** Whether the post-review toolbar is actionable (completed + ≥1 selected). */
  canPost: boolean;
  /** Open the ConfirmDialog for a verdict (human gate — never auto-fires). */
  requestPost: (verdict: ReviewVerdict) => void;
  /** Own-PR guard: GitHub rejects approve/request-changes on the viewer's own
   *  PR, so those two verdicts disable (comment stays enabled). Fail-open —
   *  false when the viewer login is unknown. */
  ownPr: boolean;
  /** The count of findings the last successful post carried — the auto-clearing
   *  "Posted N findings" inline confirmation. `null` when there's none to show. */
  postedFeedback: number | null;
  /** Selected OPEN findings count — the K in "Address findings (K)". */
  addressCount: number;
  /** Whether Address-findings is actionable (K > 0 and no fix running for this
   *  PR). Own-PR is deliberately NOT guarded — fixing your own PR is fine. */
  canAddress: boolean;
  /** True when a fix agent is already running for this PR (disables + explains
   *  the Address button; the Rust registry refuses a second one anyway). */
  fixRunning: boolean;
  /** Open the address ConfirmDialog (the human gate for starting a paid agent
   *  session that will COMMIT to the PR branch — never auto-fires). */
  requestAddress: () => void;
  /** This PR's last address rejection (per-PR, from the fix registry), or null. */
  addressError: string | null;
}

/** The RESULTS state: banners, toolbar, and the findings grid. */
export interface ReviewSectionResultsSlice {
  gridFindings: ReviewFindingView[];
  emptyMessage: string;
  /** How to render the no-findings state: `clean` (completed run, nothing found)
   *  gets the celebratory positive empty state; `neutral` (idle / failed /
   *  cancelled) the plain message. */
  emptyVariant: 'clean' | 'neutral';
  selection: ReadonlySet<string>;
  onToggleSelect: (findingId: string) => void;
  /** Replace the whole selection (the quick-select presets + per-group tri-state
   *  toggles compose it over OPEN findings; the view model stores the set). */
  onSelectionChange: (next: ReadonlySet<string>) => void;
  onOpenFinding: (finding: ReviewFindingView) => void;
  /** "New review": back to config, prefilled from the displayed run. */
  onNewReview: () => void;
  toolbar: ReviewSectionToolbarSlice;
  /** The PR's fix status strip (running → awaiting_push → pushed / failed), or
   *  `null` when no fix is known for this PR (or its latest was dismissed). */
  fix: FixRunCardProps | null;
  /** The PR's review-arc timeline (reviewed → posted → fix → pushed →
   *  re-review). The {@link ReviewTimeline} self-hides when there's no arc. */
  timeline: TimelineStep[];
  /** The review-position layer (merge verdict, reconciliation banner, staleness
   *  chip, follow-up summary) for the displayed COMPLETED run. Absent for a
   *  running/failed run; the {@link ReviewPosition} self-hides when it has
   *  nothing to show. */
  position?: ReviewPositionData;
}

/** The per-PR run-history affordance. */
export interface ReviewSectionHistorySlice {
  /** This PR's persisted runs (newest first) as menu entries. */
  items: MenuItem[];
  /** True when a past (non-latest) run's stream is being displayed. */
  viewingPastRun: boolean;
  /** Return to the PR's latest run. */
  onBackToLatest: () => void;
}

/** Props for the {@link ReviewSection}. */
export interface ReviewSectionProps {
  prNumber: number;
  mode: ReviewSectionMode;
  /** The displayed run stream (latest or a history selection), or `null` when
   *  the registry knows no run for this PR. */
  stream: ReviewStream | null;
  configure: ReviewSectionConfigSlice;
  running: ReviewSectionRunningSlice;
  results: ReviewSectionResultsSlice;
  history: ReviewSectionHistorySlice;
}
