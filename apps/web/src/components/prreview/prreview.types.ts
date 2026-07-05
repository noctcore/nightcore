/** Shared view-model types for the PR Review surface: the normalized finding
 *  shape the UI renders, the run-status union that drives the header chrome, and
 *  the three GitHub review verdicts. */
import type { ReviewLens, ReviewSeverity } from '@/lib/bridge';

/** Finding lifecycle, narrowed from the persisted `string`. */
export type FindingStatus = 'open' | 'dismissed' | 'converted';

/** A review finding as the view renders it: the unified, union-typed shape both
 *  the live wire `ReviewFinding` (contract) and the persisted `StoredReviewFinding`
 *  (ts-rs) normalize into. Diff-relative — `file` + optional `line` directly, no
 *  nested location (unlike Insight). */
export interface ReviewFindingView {
  id: string;
  lens: ReviewLens;
  severity: ReviewSeverity;
  /** Repo-relative path; a member of the PR's changed-file set (diff-relative). */
  file: string;
  /** 1-based line in the PR head, when localizable. */
  line: number | null;
  title: string;
  body: string;
  suggestedFix: string | null;
  fingerprint: string;
  /** Review lenses OTHER than `lens` that independently surfaced this same issue
   *  (the cross-lens dedup populates it). Always an array — empty when only the
   *  reporting lens found it. Drives the corroboration chip on the finding card
   *  and the fuller "also surfaced by…" line in the detail panel. */
  corroboratedBy: ReviewLens[];
  status: FindingStatus;
  linkedTaskId: string | null;
}

/** A run-status drives the header chrome + whether controls are busy. */
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed';

/** The three GitHub review verdicts, in the web's kebab wire form (the Rust core
 *  maps them to gh's `APPROVE` / `REQUEST_CHANGES` / `COMMENT`). */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';
