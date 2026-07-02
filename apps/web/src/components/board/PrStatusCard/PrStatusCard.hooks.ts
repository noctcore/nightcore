/** State + derivation helpers for the PrStatusCard: the fetch-on-mount /
 *  manual-refresh status state, the confirm-gated mutation flow, and the pure
 *  gh-vocabulary → friendly-label mappers. NO polling — a fetch happens on
 *  mount, on the Refresh button, and after a successful push; that's it. */
import { useCallback, useEffect, useState } from 'react';

import type { PrStatus, Task } from '@/lib/bridge';
import { prStatus } from '@/lib/bridge';

/** Everything the card shell renders the status block from. */
export interface PrStatusView {
  /** The last fetched status (kept across a failed refresh), or null. */
  status: PrStatus | null;
  /** True while a fetch is in flight (the Refresh button disables). */
  fetching: boolean;
  /** The last fetch failure, shown inline; a later refresh clears it. */
  error: string | null;
  /** True when the command resolved its outside-Tauri sentinel (browser
   *  preview) — the card shows a quiet unavailable note instead of lying. */
  unavailable: boolean;
  /** Web-side receive timestamp of the last successful fetch (the contract
   *  carries no timestamps — the UI stamps locally). `null` until one lands. */
  refreshedAt: number | null;
  /** Re-fetch the status (manual refresh / after a push). */
  refresh: () => void;
}

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Fetch the PR status on mount (per task id) and on demand. `override` is the
 *  story/test seam — when provided (including `null`) no fetch ever fires. */
export function usePrStatus(taskId: string, override?: PrStatus | null): PrStatusView {
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // Bumping the epoch re-runs the fetch effect (manual refresh / post-push).
  const [epoch, setEpoch] = useState(0);
  const skip = override !== undefined;

  useEffect(() => {
    if (skip) return;
    let stale = false;
    setFetching(true);
    setError(null);
    prStatus(taskId).then(
      (next) => {
        if (stale) return;
        setStatus(next);
        setUnavailable(next === null);
        setRefreshedAt(Date.now());
        setFetching(false);
      },
      (err: unknown) => {
        if (stale) return;
        console.error('pr_status failed', err);
        // Keep the last good status visible; the error line rides beside it.
        setError(errorText(err));
        setFetching(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [skip, taskId, epoch]);

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  if (skip) {
    return {
      status: override,
      fetching: false,
      error: null,
      unavailable: override === null,
      refreshedAt: null,
      refresh,
    };
  }
  return { status, fetching, error, unavailable, refreshedAt, refresh };
}

/** The card's three confirm-gated mutations. */
export type PrConfirmAction = 'push' | 'finalize' | 'pullBase';

/** The armed-confirm state: which action the ConfirmDialog is currently
 *  guarding (`null` = closed), plus the arm/cancel/confirm transitions. */
export interface PrConfirmView {
  arming: PrConfirmAction | null;
  arm: (action: PrConfirmAction) => void;
  cancel: () => void;
  /** Fire the armed action's handler and close the dialog. A push refetches
   *  the status on success; every failure is swallowed here because the shell
   *  controller already toasts it (the useCreatePr failure discipline). */
  confirm: () => void;
}

/** Confirm-gate state machine for the card's mutations. The handlers are the
 *  AppShell's guarded promises; absent handlers make `arm` a dead control (the
 *  shell hides the matching button anyway). */
export function usePrConfirm(
  taskId: string,
  refresh: () => void,
  onPushUpdates?: (id: string) => Promise<void>,
  onFinalize?: (id: string) => Promise<void>,
  onPullBase?: (id: string) => Promise<void>,
): PrConfirmView {
  const [arming, setArming] = useState<PrConfirmAction | null>(null);

  const arm = useCallback((action: PrConfirmAction) => setArming(action), []);
  const cancel = useCallback(() => setArming(null), []);

  const confirm = useCallback(() => {
    const action = arming;
    setArming(null);
    if (action === null) return;
    // Failures are already surfaced by the controller's toast; the swallow
    // keeps a rejected guard from becoming an unhandled rejection.
    if (action === 'push') {
      void onPushUpdates?.(taskId)
        .then(() => refresh())
        .catch(() => {});
    } else if (action === 'finalize') {
      void onFinalize?.(taskId).catch(() => {});
    } else {
      void onPullBase?.(taskId).catch(() => {});
    }
  }, [arming, taskId, refresh, onPushUpdates, onFinalize, onPullBase]);

  return { arming, arm, cancel, confirm };
}

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

/** The check-run counts, or `null` when all are zero (the line hides — a repo
 *  without CI shouldn't render a dead `0 passed` row). */
export function checksSummary(
  status: PrStatus,
): { passed: number; failed: number; pending: number } | null {
  const { checksPassed: passed, checksFailed: failed, checksPending: pending } = status;
  if (passed === 0 && failed === 0 && pending === 0) return null;
  return { passed, failed, pending };
}

/** Push-updates visibility: an OPEN PR with local commits its upstream lacks. */
export function canPushUpdates(status: PrStatus): boolean {
  return status.state === 'OPEN' && status.unpushedCommits > 0;
}

/** Finalize visibility: remote-merged but not yet marked merged locally. */
export function canFinalize(status: PrStatus, task: Task): boolean {
  return status.state === 'MERGED' && !task.merged;
}

/** Update-base visibility: remote-merged AND already finalized locally. */
export function canPullBase(status: PrStatus, task: Task): boolean {
  return status.state === 'MERGED' && task.merged;
}

/** The ConfirmDialog copy per armed action — each states exactly what the
 *  mutation does (the human gate names the branch/count/base, never a vague
 *  "are you sure"). */
export function confirmCopy(
  action: PrConfirmAction,
  status: PrStatus,
  task: Task,
): { title: string; message: string; confirmLabel: string } {
  if (action === 'push') {
    const n = status.unpushedCommits;
    const branch = task.branch ?? 'the task branch';
    return {
      title: 'Push updates to the pull request?',
      message: `Push ${n} commit${n === 1 ? '' : 's'} on ${branch} to origin (plain push — never forced). The pull request updates in place.`,
      confirmLabel: 'Push updates',
    };
  }
  if (action === 'finalize') {
    return {
      title: 'Finalize the merged pull request?',
      message: `PR #${status.number} was merged on GitHub. This marks the task merged locally and removes its worktree per the cleanup setting; the board updates via the task echo.`,
      confirmLabel: 'Finalize',
    };
  }
  return {
    title: 'Update the base branch?',
    message: `Fast-forward-only pull of ${status.baseRefName} on the project root. Refused if the root is dirty or the pull is not a fast-forward.`,
    confirmLabel: 'Update base',
  };
}

/** Format the web-side receive timestamp for the "Refreshed …" footer line. */
export function formatRefreshedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
