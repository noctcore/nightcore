/** Types for the global cross-kind run History view. TS-only — nothing crosses a
 *  wire here; the inputs are the already-generated per-family run types, merged
 *  into one slim summary the list renders from (spec: Views Phase 2). */

/** The single-run scan families History aggregates. PR Review (concurrent) and
 *  Issue Triage (list-driven) are deliberately excluded — different molds. */
export type ScanFamily = 'insight' | 'scorecard' | 'harness';

/** One run, flattened to the fields the History list renders. Derived web-side
 *  from `InsightRun` / `ScorecardRun` / `HarnessRun` (all three share
 *  `id / projectPath / status / createdAt`; `title` is derived per family since
 *  the stored runs carry no title of their own). */
export interface ScanRunSummary {
  id: string;
  family: ScanFamily;
  /** A short, family-derived label (e.g. `3 findings`, `2 dimensions graded`). */
  title: string;
  /** Pass-through of the per-family status string (`running`/`completed`/`failed`). */
  status: string;
  createdAt: number;
  projectPath: string;
}

/** The merged-history hook result: the project-filtered, newest-first run list, a
 *  first-load flag, a non-blocking warning when a family failed to load (the
 *  others still merge), and a manual re-fetch. */
export interface AllScanRuns {
  runs: ScanRunSummary[];
  loading: boolean;
  /** Non-null when one or more families failed to load — the loaded families
   *  still populate `runs`; this drives a non-blocking warning row. */
  error: string | null;
  refresh: () => void;
}

/** Props for the routed History view. */
export interface HistoryViewProps {
  /** The active project's repo path; `null` when none is open. */
  projectPath: string | null;
  /** Open a run on its owning stage (Understand / Enforce), run-level. */
  onOpenRun: (family: ScanFamily, runId: string) => void;
}

/** Props for the presentational history list (story-able without the bridge). */
export interface HistoryListProps {
  runs: ScanRunSummary[];
  loading: boolean;
  error: string | null;
  onOpenRun: (family: ScanFamily, runId: string) => void;
}
