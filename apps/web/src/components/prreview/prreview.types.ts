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

/**
 * The POST-REVIEW human gate: everything the confirm dialog pre-fills, everything
 * the human can edit there, and the two terminal actions. Declared at the feature
 * root (not inside `PrReviewView`) so the dialog component can type its props
 * without importing back into the view that renders it.
 *
 * Posting to GitHub is an OUTWARD-FACING action: {@link PostReviewGate.confirmPost}
 * is the only member that reaches the network, and the only caller is the dialog's
 * confirm button. Nothing in this bundle auto-posts.
 */
export interface PostReviewGate {
  /** The verdict whose ConfirmDialog is open, or `null` (gate closed). */
  postVerdict: ReviewVerdict | null;
  posting: boolean;
  postError: string | null;
  /** The PR the armed post targets (the displayed run's PR). */
  postPrNumber: number | null;
  selectedCount: number;
  /** How many selected findings are PRE-SELECTED as inline diff comments. */
  selectedInlineCount: number;
  /** How many ride in the review body note instead (lows/info + un-anchorable). */
  selectedBodyCount: number;
  /** The human's edit of the split: every anchorable selection goes inline. */
  postAllInline: boolean;
  setPostAllInline: (next: boolean) => void;
  /** The verdict the gate PRE-FILLS, derived from the run's clamped merge verdict
   *  (own-PR safe). A recommendation — the human may pick any verdict. */
  recommendedVerdict: ReviewVerdict;
  /** Why the merge verdict was mechanically clamped, when it was — shown beside
   *  the recommendation so the pre-fill explains itself. */
  clampReason: string | null;
  /** Re-arm the gate on a DIFFERENT verdict (the dialog's verdict selector — the
   *  human's edit of the pre-fill). Never posts; it only re-opens. */
  requestPost: (verdict: ReviewVerdict) => void;
  /** Confirm + await the post. The ONLY path that reaches GitHub, and only from an
   *  explicit human confirmation. */
  confirmPost: () => void;
  /** Cancel the gate. A no-op while a post is in flight. */
  cancelPost: () => void;
}
