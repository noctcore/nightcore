/**
 * The per-PR REVIEW-POSITION layer: pure derivations that place a PR on its
 * review lifecycle from the inputs Nightcore already holds — the run registry's
 * display stream, the latest persisted run (its `postedVerdict` / `verdict` /
 * `headSha`), the fix registry entry, and the live GitHub {@link PrStatus}
 * (`headRefOid`). Everything here is a pure function of those inputs (no React,
 * no bridge calls) so each surface — the picker rows, the workspace status line,
 * the results banners — reads one shared, independently-tested model.
 *
 * The lifecycle machine mirrors the reference status derivation: an active
 * review wins first (so switching back mid-run shows the live state), then a fix
 * in flight, then — for a completed review — staleness beats a posted verdict
 * beats a pending post. Staleness (`headSha` moved) both flags the results chip
 * and collapses into the `stale` lifecycle state.
 */
import type { PrFixState, PrReviewRun, PrStatus } from '@/lib/bridge';

import type { ReviewStream } from './prreview-stream';

/** Where a PR sits on the review lifecycle. The exact set the inputs genuinely
 *  distinguish — a failed/idle run with no completed result reads as
 *  `not_reviewed` (the results pane owns the failure detail). */
export type ReviewLifecycleState =
  | 'not_reviewed'
  | 'reviewing'
  | 'reviewed_pending_post'
  | 'posted'
  | 'fix_in_flight'
  | 'stale';

/** A lifecycle tone, mapped to Nightcore's semantic tokens by
 *  {@link lifecycleToneClasses} (never a raw palette). */
export type LifecycleTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive';

/** The resolved lifecycle for one PR: a state plus the label/description/tone
 *  the surfaces render (the reference carries the same bundle on its derived
 *  status). `shortLabel` is the picker-row form; `label` the fuller status-line
 *  form. `pulse` drives the animated dot for the active states. */
export interface ReviewLifecycle {
  state: ReviewLifecycleState;
  /** Fuller label for the workspace status line. */
  label: string;
  /** Compact label for the picker row. */
  shortLabel: string;
  /** One-line description of the position (like the reference). */
  description: string;
  tone: LifecycleTone;
  /** True for the in-motion states (an active review / a running fix). */
  pulse: boolean;
  /** True when the branch advanced past the reviewed head — the results chip
   *  and the `stale` state both read this. */
  stale: boolean;
}

/** The inputs a per-PR lifecycle derives from. */
export interface LifecycleInputs {
  /** The PR's display stream from the run registry (running-first), or null. */
  stream: ReviewStream | null;
  /** The PR's latest PERSISTED run (newest-first head), or null — the source of
   *  `postedVerdict` / `verdict` / `headSha`, which the stream doesn't carry. */
  latestRun: PrReviewRun | null;
  /** The PR's latest fix registry entry, or null. */
  fix: PrFixState | null;
  /** Live GitHub status for the PR (its `headRefOid` drives staleness), or null
   *  when it hasn't been fetched (the picker rows never have it). */
  prStatus: PrStatus | null;
  /** True inside the Review-click → optimistic-entry gap for the SELECTED PR. */
  isStarting?: boolean;
}

/** Tailwind class bundle for a tone: the status dot, the label text, and the
 *  status-line card's border/background — all semantic tokens. */
export interface LifecycleToneClasses {
  dot: string;
  text: string;
  border: string;
  bg: string;
}

const TONE_CLASSES: Record<LifecycleTone, LifecycleToneClasses> = {
  neutral: {
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
    border: 'border-border',
    bg: 'bg-white/[0.02]',
  },
  primary: {
    dot: 'bg-primary',
    text: 'text-primary',
    border: 'border-primary/40',
    bg: 'bg-primary/[0.06]',
  },
  success: {
    dot: 'bg-success',
    text: 'text-success',
    border: 'border-success/40',
    bg: 'bg-success/[0.08]',
  },
  warning: {
    dot: 'bg-warning',
    text: 'text-warning',
    border: 'border-warning/40',
    bg: 'bg-warning/[0.08]',
  },
  destructive: {
    dot: 'bg-destructive',
    text: 'text-destructive',
    border: 'border-destructive/40',
    bg: 'bg-destructive/[0.08]',
  },
};

/** Resolve a tone to its semantic class bundle. */
export function lifecycleToneClasses(tone: LifecycleTone): LifecycleToneClasses {
  return TONE_CLASSES[tone];
}

/** The lifecycle states offered as the list's status multi-select filter, in
 *  display order with their menu labels. A PR with no derived lifecycle reads as
 *  `not_reviewed` for filtering, so every open PR is reachable by some option. */
export const LIFECYCLE_FILTER_OPTIONS: ReadonlyArray<{
  state: ReviewLifecycleState;
  label: string;
}> = [
  { state: 'reviewing', label: 'Reviewing' },
  { state: 'not_reviewed', label: 'Not reviewed' },
  { state: 'reviewed_pending_post', label: 'Reviewed' },
  { state: 'posted', label: 'Posted' },
  { state: 'fix_in_flight', label: 'Fixing' },
  { state: 'stale', label: 'Stale' },
];

/** A run is "in flight" when it's live-running or the persisted head still reads
 *  `running` (a reload before the terminal event lands). */
function isRunning(stream: ReviewStream | null, latestRun: PrReviewRun | null): boolean {
  return stream?.status === 'running' || latestRun?.status === 'running';
}

/** A run "completed" when either the live stream or the persisted head says so. */
function isCompleted(stream: ReviewStream | null, latestRun: PrReviewRun | null): boolean {
  return stream?.status === 'completed' || latestRun?.status === 'completed';
}

/** The fix stages that read as still part of the fix arc (awaiting-push is the
 *  human gate, not "done" — the fix strip still shows it). `pushed` / `failed`
 *  are terminal and fall through to the review's own position. */
function isFixInFlight(fix: PrFixState | null): fix is PrFixState {
  return (
    fix !== null &&
    (fix.status === 'running' ||
      fix.status === 'committing' ||
      fix.status === 'awaiting_push')
  );
}

/** Count OPEN findings across either finding source (both carry `status`). */
function countOpen(findings: ReadonlyArray<{ status: string }>): number {
  return findings.filter((f) => f.status === 'open').length;
}

/** A posted verdict's friendly noun for the description line. */
function postedVerdictText(verdict: string): string {
  switch (verdict) {
    case 'approve':
      return 'approval';
    case 'request-changes':
      return 'change request';
    case 'comment':
      return 'comment';
    default:
      return verdict;
  }
}

/** A posted verdict's tone: an approval reads success, a change request warns,
 *  a comment is neutral-accent. */
function postedVerdictTone(verdict: string): LifecycleTone {
  switch (verdict) {
    case 'approve':
      return 'success';
    case 'request-changes':
      return 'warning';
    default:
      return 'primary';
  }
}

/** The fix-stage description for the `fix_in_flight` state. */
function fixStageDescription(status: string): string {
  switch (status) {
    case 'committing':
      return 'Committing the fix to the PR branch.';
    case 'awaiting_push':
      return 'Fix committed — ready to push to the PR branch.';
    default:
      return 'A fix agent is addressing the selected findings.';
  }
}

/**
 * Whether the latest review is STALE: the PR advanced past the head SHA the run
 * reviewed. Both SHAs must be present and the PR still OPEN (a merged/closed PR
 * moving on isn't a review that needs refreshing). Fail-closed on missing data —
 * an older run without `headSha`, or a status without `headRefOid`, is never
 * flagged stale (it would be a false alarm).
 */
export function isReviewStale(
  latestRun: PrReviewRun | null,
  prStatus: PrStatus | null,
): boolean {
  if (latestRun === null || prStatus === null) return false;
  if (prStatus.state !== 'OPEN') return false;
  const reviewed = latestRun.headSha;
  const live = prStatus.headRefOid;
  if (reviewed === null || reviewed === '' || live === '') return false;
  return reviewed !== live;
}

/** Derive one PR's review lifecycle from its inputs. */
export function deriveReviewLifecycle(input: LifecycleInputs): ReviewLifecycle {
  const { stream, latestRun, fix, prStatus, isStarting = false } = input;

  // 1. An active review wins outright — checked first (like the reference's
  //    isReviewing gate) so returning to a PR mid-run shows the live state.
  if (isStarting || isRunning(stream, latestRun)) {
    return {
      state: 'reviewing',
      label: 'Reviewing',
      shortLabel: 'Reviewing',
      description: 'Reviewing the PR diff across the review lenses.',
      tone: 'primary',
      pulse: true,
      stale: false,
    };
  }

  // 2. A fix agent working the branch (before it publishes).
  if (isFixInFlight(fix)) {
    return {
      state: 'fix_in_flight',
      label: 'Fixing',
      shortLabel: 'Fixing',
      description: fixStageDescription(fix.status),
      tone: 'primary',
      pulse: fix.status !== 'awaiting_push',
      stale: false,
    };
  }

  // 3. No completed review yet (idle / failed / never run).
  if (!isCompleted(stream, latestRun)) {
    return {
      state: 'not_reviewed',
      label: 'Not reviewed',
      shortLabel: 'Not reviewed',
      description: 'Run an AI review across the selected lenses.',
      tone: 'neutral',
      pulse: false,
      stale: false,
    };
  }

  // 4. Stale — the branch moved since the review. Beats the posted/pending
  //    positions: a review of an old head is out of date however it was acted
  //    on. (A running fix already returned above, so this never fires mid-fix.)
  if (isReviewStale(latestRun, prStatus)) {
    return {
      state: 'stale',
      label: 'Branch moved',
      shortLabel: 'Stale',
      description:
        'The branch has new commits since this review — re-review to refresh.',
      tone: 'warning',
      pulse: false,
      stale: true,
    };
  }

  // 5. Posted — a verdict was posted to GitHub (tone follows the verdict).
  const posted = latestRun?.postedVerdict ?? null;
  if (posted !== null && posted !== '') {
    return {
      state: 'posted',
      label: 'Review posted',
      shortLabel: 'Posted',
      description: `Posted a ${postedVerdictText(posted)} to GitHub.`,
      tone: postedVerdictTone(posted),
      pulse: false,
      stale: false,
    };
  }

  // 6. Reviewed, not posted — the natural resting place of a fresh review.
  const findings = latestRun?.findings ?? stream?.findings ?? [];
  const open = countOpen(findings);
  return {
    state: 'reviewed_pending_post',
    label: 'Reviewed',
    shortLabel: 'Reviewed',
    description:
      open === 0
        ? 'No findings — the diff looks clean across the selected lenses.'
        : `${open} ${open === 1 ? 'finding' : 'findings'} — select and post to GitHub.`,
    tone: 'primary',
    pulse: false,
    stale: false,
  };
}

/**
 * Whether a POSTED approving verdict now contradicts the live PR status, and the
 * contradictions to name (the reference's "verdict may be outdated" banner). It
 * fires only when the review's position is approving — a posted `approve`, or a
 * synthesis `ready` verdict — and the PR is still OPEN. Each live blocker
 * (failing checks, behind base, conflicts) becomes one reason line. An empty
 * array means no contradiction (render nothing).
 */
export function reconcilePostedVerdict(
  latestRun: PrReviewRun | null,
  prStatus: PrStatus | null,
): string[] {
  if (latestRun === null || prStatus === null) return [];
  if (prStatus.state !== 'OPEN') return [];
  const approving =
    latestRun.postedVerdict === 'approve' || latestRun.verdict === 'ready';
  if (!approving) return [];

  const reasons: string[] = [];
  if (prStatus.checksFailed > 0) {
    reasons.push(
      `${prStatus.checksFailed} check${prStatus.checksFailed === 1 ? '' : 's'} failing`,
    );
  }
  if (prStatus.mergeStateStatus === 'BEHIND') {
    reasons.push('Branch is behind the base');
  }
  // DIRTY and a CONFLICTING mergeable describe the same conflict — collapse them
  // into one line so the banner never double-lists it.
  if (prStatus.mergeStateStatus === 'DIRTY' || prStatus.mergeable === 'CONFLICTING') {
    reasons.push('Merge conflicts with the base');
  }
  return reasons;
}

/** A latest-vs-previous run comparison by finding fingerprint. */
export interface FollowupComparison {
  /** Fingerprints in the previous run absent from the latest (fixed / gone). */
  resolved: number;
  /** Fingerprints present in BOTH runs (still open). */
  stillOpen: number;
  /** Fingerprints new to the latest run. */
  added: number;
  /** The still-open (recurring) fingerprints — the latest-run cards carrying one
   *  get the subtle "still open" chip. */
  recurringFingerprints: ReadonlySet<string>;
}

/**
 * Compare two runs' findings by fingerprint: what the newer review resolved,
 * what still stands, and what's new since the previous review. Fingerprint
 * identity is the only signal — a finding present in both runs is "still open"
 * regardless of either run's per-finding lifecycle (a fresh review re-surfaces
 * live findings as `open`).
 */
export function compareRuns(
  latest: ReadonlyArray<{ fingerprint: string }>,
  previous: ReadonlyArray<{ fingerprint: string }>,
): FollowupComparison {
  const prevFps = new Set(previous.map((f) => f.fingerprint));
  const latestFps = new Set(latest.map((f) => f.fingerprint));

  let resolved = 0;
  for (const fp of prevFps) if (!latestFps.has(fp)) resolved += 1;

  const recurringFingerprints = new Set<string>();
  let added = 0;
  for (const fp of latestFps) {
    if (prevFps.has(fp)) recurringFingerprints.add(fp);
    else added += 1;
  }

  return {
    resolved,
    stillOpen: recurringFingerprints.size,
    added,
    recurringFingerprints,
  };
}

/** A review-arc timeline node's completion state — mapped to a dot glyph + tone
 *  by the {@link ../ReviewTimeline}. */
export type TimelineStepState = 'done' | 'current' | 'upcoming' | 'alert';

/** One node on the PR's review arc (reviewed → posted → fix → pushed →
 *  re-review). `at` is an epoch-ms timestamp, or null when the step hasn't
 *  happened / carries no time. */
export interface TimelineStep {
  id: string;
  label: string;
  state: TimelineStepState;
  at: number | null;
}

/**
 * Derive the PR's review-arc timeline from its latest persisted run + fix (the
 * same inputs the History menu and FixRunCard read separately), unifying them
 * into one stepper. A live/failed review short-circuits to a single node (the
 * results banner + status line own that detail); a completed review yields the
 * reviewed → posted arc, extended by a fix node and a re-review nudge when the
 * branch has moved. Pure — the component renders whatever comes back.
 */
export function deriveReviewTimeline(
  latestRun: PrReviewRun | null,
  fix: PrFixState | null,
  stale = false,
): TimelineStep[] {
  if (latestRun === null) return [];

  if (latestRun.status === 'running') {
    return [{ id: 'review', label: 'Reviewing', state: 'current', at: latestRun.createdAt }];
  }
  if (latestRun.status === 'failed') {
    return [{ id: 'review', label: 'Review failed', state: 'alert', at: latestRun.updatedAt }];
  }

  const steps: TimelineStep[] = [
    { id: 'review', label: 'Reviewed', state: 'done', at: latestRun.createdAt },
  ];

  // Posted — a real GitHub post (done, with its time) or the pending/none rest.
  const posted = latestRun.postedVerdict !== null && latestRun.postedVerdict !== '';
  if (posted) {
    steps.push({ id: 'posted', label: 'Posted to GitHub', state: 'done', at: latestRun.postedAt });
  } else {
    const openCount = countOpen(latestRun.findings);
    steps.push({
      id: 'posted',
      label: openCount > 0 ? 'Pending post' : 'Nothing to post',
      state: 'upcoming',
      at: null,
    });
  }

  // Fix arc (only when a fix exists for the PR).
  if (fix !== null) {
    if (fix.status === 'running' || fix.status === 'committing') {
      steps.push({ id: 'fix', label: 'Fix running', state: 'current', at: fix.updatedAt });
    } else if (fix.status === 'awaiting_push') {
      steps.push({ id: 'fix', label: 'Fix ready to push', state: 'current', at: fix.updatedAt });
    } else if (fix.status === 'pushed') {
      steps.push({ id: 'fix', label: 'Fix pushed', state: 'done', at: fix.updatedAt });
    } else if (fix.status === 'failed') {
      steps.push({ id: 'fix', label: 'Fix failed', state: 'alert', at: fix.updatedAt });
    }
  }

  // Re-review nudge when the branch advanced past the reviewed head.
  if (stale) {
    steps.push({ id: 're-review', label: 'Re-review — branch moved', state: 'upcoming', at: null });
  }

  return steps;
}
