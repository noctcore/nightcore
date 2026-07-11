/** Prop + view types for the review-time Evidence bundle (wayfinder T8). The
 *  bundle stages the per-task receipt — the gauntlet verbatim, diff stats, the
 *  guardrail ledger, and the (approximate) cost — right at the reviewer's
 *  Accept / Reject decision, reusing the Trust Report's presentational sections. */
import type { Task, TrustReport } from '@/lib/bridge';

/** The worktree diff totals surfaced beside the receipt (files changed + line
 *  counts of `base..HEAD`, working-tree-inclusive). */
export interface EvidenceDiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** The two fetched inputs of the bundle. Either may be `null` (fail-open): a
 *  main-mode task has no worktree diff; a run with no ledger/transcript has no
 *  receipt yet. */
export interface EvidenceData {
  report: TrustReport | null;
  diff: EvidenceDiffStat | null;
}

/** Everything the bundle renders from — the fetched receipt + diff plus the
 *  loading / unavailable / error flags (mirroring the Trust band's fetch view). */
export interface EvidenceView extends EvidenceData {
  loading: boolean;
  /** True when the receipt resolved to `null` with no error (browser preview /
   *  nothing recorded) — the bundle shows a quiet note rather than an error. */
  unavailable: boolean;
  error: string | null;
}

/** Props for the {@link EvidenceBundle}. */
export interface EvidenceBundleProps {
  /** The task under review whose evidence is staged. */
  task: Task;
  /** Story/test override: when provided (including nulls) no bridge fetch fires
   *  and the bundle renders this data directly. */
  data?: EvidenceData;
}
