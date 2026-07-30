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
  /** The model the run used (`''` when unrecorded). Persisted per run (T8). */
  model: string;
  /** Approximate total run cost in USD (from the transcript). Persisted per run. */
  costUsd: number;
  /** Wall-clock run duration in ms; `0` when unrecorded. Persisted per run. */
  durationMs: number;
}

/** The merged-history hook result: the project-filtered, newest-first run list, a
 *  first-load flag, a non-blocking warning when a family failed to load (the
 *  others still merge), a manual re-fetch, the core's per-kind retention cap, and the
 *  per-row delete. */
export interface AllScanRuns {
  runs: ScanRunSummary[];
  loading: boolean;
  /** Non-null when one or more families failed to load — the loaded families
   *  still populate `runs`; this drives a non-blocking warning row. */
  error: string | null;
  refresh: () => void;
  /** How many runs per kind the core retains before pruning the oldest settled ones
   *  (`AppInfo.scanRunRetention`); `null` until the probe resolves. Read from the
   *  enforcing constant so the retention notice can never drift from the cap. */
  retention: number | null;
  /** Delete one run and drop it from the list. Resolves once the row is gone. */
  deleteRun: (family: ScanFamily, runId: string) => Promise<void>;
}

/** The run statuses History filters by. `all` is the unfiltered default; the rest
 *  match the per-family status strings the stores persist. */
export type HistoryStatusFilter = 'all' | 'running' | 'completed' | 'failed';

/** The family filter — `all`, or exactly one {@link ScanFamily}. */
export type HistoryFamilyFilter = 'all' | ScanFamily;

/** The History filter state + the narrowed list it produces. Purely derived: the
 *  filters never re-fetch, they only narrow what the merge hook already loaded. */
export interface HistoryFilters {
  family: HistoryFamilyFilter;
  status: HistoryStatusFilter;
  setFamily: (family: HistoryFamilyFilter) => void;
  setStatus: (status: HistoryStatusFilter) => void;
  /** `runs` narrowed by both filters, order preserved (newest-first). */
  visible: ScanRunSummary[];
  /** True when a filter is hiding at least one loaded run — drives the "showing N
   *  of M" line so a narrowed list never reads as an empty history. */
  narrowed: boolean;
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
  /** Delete one run. Omitted ⇒ rows render without a delete affordance (stories
   *  that only exercise the read-only list). */
  onDeleteRun?: (family: ScanFamily, runId: string) => void;
  /** The core's per-kind retention cap, for the transparency footer. `null`/omitted
   *  ⇒ the footer states the rule without a number. */
  retention?: number | null;
  /** Total loaded runs before filtering, when a filter is narrowing the list — drives
   *  "showing N of M". Omitted ⇒ nothing is hidden. */
  totalRuns?: number;
}

/** Props for the filter bar above the list. */
export interface HistoryFilterBarProps {
  family: HistoryFamilyFilter;
  status: HistoryStatusFilter;
  onFamilyChange: (family: HistoryFamilyFilter) => void;
  onStatusChange: (status: HistoryStatusFilter) => void;
  /** Per-family loaded counts, so a filter chip can show what it would reveal. */
  counts: Record<ScanFamily, number>;
}
