/**
 * Pure gh-vocabulary → friendly-label mappers for a {@link PrStatus} snapshot,
 * hoisted out of `board/PrStatusCard` so the PR Review workspace can render the
 * same status block. `apps/web/src/lib/` is the only place the
 * `no-cross-feature-imports` lint permits cross-feature sharing — board and
 * prreview both consume these from here. Unknown gh vocabulary always degrades
 * to a raw pass-through with a neutral tone, never a guess.
 */
import type { PrStatus } from '@/lib/bridge';

/** A badge's label + tone classes (the TaskDetail chip vocabulary). */
export interface PrBadge {
  label: string;
  className: string;
}

const BADGE_NEUTRAL = 'border-border bg-white/[0.04] text-muted-foreground';
const BADGE_SUCCESS = 'border-success/40 bg-success/[0.12] text-success';
const BADGE_WARNING = 'border-warning/40 bg-warning/[0.12] text-warning';
const BADGE_DANGER = 'border-destructive/40 bg-destructive/[0.12] text-destructive';
const BADGE_PRIMARY = 'border-primary/40 bg-primary/[0.12] text-primary';

/** The PR state badge. Draft wins over Open (a draft PR reports state OPEN);
 *  unknown gh vocabulary passes through raw with a neutral tone. */
export function prStateBadge(status: PrStatus): PrBadge {
  if (status.state === 'OPEN') {
    return status.isDraft
      ? { label: 'Draft', className: BADGE_NEUTRAL }
      : { label: 'Open', className: BADGE_SUCCESS };
  }
  if (status.state === 'MERGED') return { label: 'Merged', className: BADGE_PRIMARY };
  if (status.state === 'CLOSED') return { label: 'Closed', className: BADGE_DANGER };
  return { label: status.state, className: BADGE_NEUTRAL };
}

/** The review-decision badge, or `null` when GitHub reports none (`""`).
 *  Unknown vocabulary passes through raw with a neutral tone. */
export function reviewDecisionBadge(status: PrStatus): PrBadge | null {
  switch (status.reviewDecision) {
    case '':
      return null;
    case 'APPROVED':
      return { label: 'Approved', className: BADGE_SUCCESS };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', className: BADGE_DANGER };
    case 'REVIEW_REQUIRED':
      return { label: 'Review required', className: BADGE_WARNING };
    default:
      return { label: status.reviewDecision, className: BADGE_NEUTRAL };
  }
}

/** Friendly text for the known `mergeStateStatus` vocabulary. */
const MERGE_STATE_TEXT: Record<string, string> = {
  CLEAN: 'Clean against base',
  BEHIND: 'Behind base',
  BLOCKED: 'Blocked — reviews or required checks outstanding',
  DIRTY: 'Conflicts with base',
  UNSTABLE: 'Mergeable — non-required checks failing',
  DRAFT: 'Draft — not ready to merge',
};

/** One line summarizing `mergeable` + `mergeStateStatus` for an OPEN PR;
 *  `null` when the PR is merged/closed (the line is meaningless then). Unknown
 *  vocabulary degrades to the raw strings rather than guessing. */
export function mergeStateLine(status: PrStatus): string | null {
  if (status.state !== 'OPEN') return null;
  if (status.mergeable === 'CONFLICTING') return 'Conflicts with base';
  if (status.mergeable === 'UNKNOWN') return 'Merge state not computed yet';
  const known = MERGE_STATE_TEXT[status.mergeStateStatus];
  if (known !== undefined) return known;
  return `${status.mergeable} · ${status.mergeStateStatus}`;
}

/** The four-branch fallback line shown when there's no status snapshot to
 *  render — a shared ladder (fetching → unavailable → failed → not-loaded) so
 *  the board card and the PR Review status block can never drift from each
 *  other. Pure over the view's three flags. */
export function prStatusFallbackMessage(view: {
  fetching: boolean;
  unavailable: boolean;
  error: string | null;
}): string {
  if (view.fetching) return 'Fetching PR status…';
  if (view.unavailable) return 'PR status is unavailable in the browser preview.';
  if (view.error !== null) return 'PR status failed to load.';
  return 'PR status not loaded yet.';
}

/** Format the web-side receive timestamp for the "Refreshed …" footer line.
 *  Shared by the board card and the PR Review status block (both stamp the
 *  receive time locally — the contract carries no timestamps). */
export function formatRefreshedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** The check-run counts, or `null` when all are zero (the line hides — a repo
 *  without CI shouldn't render a dead `0 passed` row). */
export function checksSummary(
  status: PrStatus,
): { passed: number; failed: number; pending: number } | null {
  const { checksPassed: passed, checksFailed: failed, checksPending: pending } = status;
  if (passed === 0 && failed === 0 && pending === 0) return null;
  return { passed, failed, pending };
}

/** The single merge-readiness call for an OPEN PR — the at-a-glance badge
 *  answering "can this merge right now, and if not, what's in the way?".
 *  Severity-ordered: conflicts > failing checks > changes requested > draft >
 *  running checks > review required > ready. `null` when the PR isn't open
 *  (the state badge already says Merged/Closed) or when GitHub hasn't computed
 *  mergeability yet (`UNKNOWN` must not guess). */
export function mergeReadiness(status: PrStatus): PrBadge | null {
  if (status.state !== 'OPEN') return null;
  if (status.mergeable === 'CONFLICTING') {
    return { label: 'Conflicts — needs resolution', className: BADGE_DANGER };
  }
  if (status.checksFailed > 0) {
    return { label: 'Needs fixing — checks failing', className: BADGE_DANGER };
  }
  if (status.reviewDecision === 'CHANGES_REQUESTED') {
    return { label: 'Needs fixing — changes requested', className: BADGE_DANGER };
  }
  if (status.isDraft) {
    return { label: 'Draft — not ready', className: BADGE_NEUTRAL };
  }
  if (status.checksPending > 0) {
    return { label: 'Checks running', className: BADGE_WARNING };
  }
  if (status.reviewDecision === 'REVIEW_REQUIRED') {
    return { label: 'Needs review', className: BADGE_WARNING };
  }
  if (status.mergeable === 'UNKNOWN') return null;
  return { label: 'Ready to merge', className: BADGE_SUCCESS };
}
