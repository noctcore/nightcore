/** State + derivation helpers for the PrReviewComments section: the fetch-on-
 *  mount / manual-refresh review-comments state, the confirm-gated address-run
 *  flow, and the pure count / eligibility / gh-vocabulary → label mappers. NO
 *  polling — a fetch happens on mount and on the Refresh button; that's it. The
 *  comment bodies are UNTRUSTED external text; nothing here interprets them. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PrReviewComments, Task } from '@/lib/bridge';
import { listPrComments } from '@/lib/bridge';

/** Everything the section shell renders the comments block from. Mirrors
 *  `PrStatusView`: the payload is stamped with a local receive-time (the
 *  contract carries no timestamps) and survives a failed refresh. */
export interface PrReviewCommentsView {
  /** The last fetched payload (kept across a failed refresh), or null. */
  comments: PrReviewComments | null;
  /** True while a fetch is in flight (the Refresh button disables). */
  fetching: boolean;
  /** The last fetch failure, shown inline; a later refresh clears it. */
  error: string | null;
  /** Only ever true via the `override = null` story/test seam: the `list_pr_
   *  comments` fetch resolves an EMPTY payload (not null) outside Tauri, so the
   *  browser-preview path renders the empty state rather than this note. */
  unavailable: boolean;
  /** Web-side receive timestamp of the last successful fetch. `null` until one
   *  lands (the contract carries no timestamps — the UI stamps locally). */
  refreshedAt: number | null;
  /** Re-fetch the comments (manual refresh). */
  refresh: () => void;
}

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Fetch the PR review comments on mount (per task id) and on demand. `override`
 *  is the story/test seam — when provided (including `null`) no fetch ever fires.
 *  `enabled=false` (a task with no PR) renders the inert empty view and fetches
 *  nothing. The OWNER of this hook is TaskDetail, which lifts it so the section
 *  card renders the shared view (mirroring the lifted `usePrStatus`). */
export function usePrReviewComments(
  taskId: string,
  enabled: boolean = true,
  override?: PrReviewComments | null,
): PrReviewCommentsView {
  const [comments, setComments] = useState<PrReviewComments | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // Bumping the epoch re-runs the fetch effect (manual refresh).
  const [epoch, setEpoch] = useState(0);
  const skip = override !== undefined || !enabled;

  // Task-switch reset (belt — the `key={task.id}` at the render site is the
  // suspenders): the hook instance survives a task switch, so task A's snapshot
  // (comments/error/refreshedAt) would render — and ARM the address confirm —
  // against task B until B's fetch lands. The render-adjust pattern resets
  // synchronously before paint (an effect-time reset would flash a stale frame
  // where A's comment count arms the Address run against B).
  const [lastTaskId, setLastTaskId] = useState(taskId);
  if (lastTaskId !== taskId) {
    setLastTaskId(taskId);
    setComments(null);
    setError(null);
    setRefreshedAt(null);
  }

  useEffect(() => {
    if (skip) return;
    let stale = false;
    setFetching(true);
    setError(null);
    listPrComments(taskId).then(
      (next) => {
        if (stale) return;
        setComments(next);
        setRefreshedAt(Date.now());
        setFetching(false);
      },
      (err: unknown) => {
        if (stale) return;
        console.error('list_pr_comments failed', err);
        // Keep the last good payload visible; the error line rides beside it.
        setError(errorText(err));
        setFetching(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [skip, taskId, epoch]);

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  // Memoized: the view crosses the memoized TaskDetailChrome as a prop, so its
  // identity must only turn over when the VIEW changes — an unmemoized object
  // literal would re-identify on every stream flush and defeat the chrome memo.
  return useMemo<PrReviewCommentsView>(() => {
    if (override !== undefined) {
      return {
        comments: override,
        fetching: false,
        error: null,
        unavailable: override === null,
        refreshedAt: null,
        refresh,
      };
    }
    if (!enabled) {
      return {
        comments: null,
        fetching: false,
        error: null,
        unavailable: false,
        refreshedAt: null,
        refresh,
      };
    }
    // Fetch mode: the bridge fallback is an EMPTY payload (never null), so
    // `unavailable` is unreachable here — the empty payload renders the empty
    // state instead.
    return { comments, fetching, error, unavailable: false, refreshedAt, refresh };
  }, [override, enabled, comments, fetching, error, refreshedAt, refresh]);
}

/** The armed-confirm state for the single Address-comments action (`false` =
 *  closed), plus the arm/cancel/confirm transitions. Mirrors `usePrConfirm`. */
export interface AddressConfirmView {
  arming: boolean;
  arm: () => void;
  cancel: () => void;
  /** Fire the address handler and close the dialog. The rejection is swallowed
   *  here because the shell controller already toasts it (the usePrConfirm
   *  failure discipline) — the swallow keeps a rejected guard from becoming an
   *  unhandled rejection. */
  confirm: () => void;
}

/** Confirm-gate state machine for the Address-comments run. `onAddressComments`
 *  is the AppShell's guarded promise; an absent handler makes `confirm` a no-op
 *  (the shell hides/disables the button anyway). */
export function useAddressConfirm(
  taskId: string,
  onAddressComments?: (id: string) => Promise<void>,
): AddressConfirmView {
  const [arming, setArming] = useState(false);

  const arm = useCallback(() => setArming(true), []);
  const cancel = useCallback(() => setArming(false), []);

  const confirm = useCallback(() => {
    setArming(false);
    void onAddressComments?.(taskId).catch(() => {});
  }, [taskId, onAddressComments]);

  return { arming, arm, cancel, confirm };
}

/** A badge's label + tone classes (the TaskDetail chip vocabulary; copied from
 *  the PrStatusCard set rather than cross-imported). */
export interface PrCommentBadge {
  label: string;
  className: string;
}

export const BADGE_BASE =
  'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]';

export const BADGE_NEUTRAL = 'border-border bg-white/[0.04] text-muted-foreground';
const BADGE_SUCCESS = 'border-success/40 bg-success/[0.12] text-success';
const BADGE_WARNING = 'border-warning/40 bg-warning/[0.12] text-warning';
const BADGE_DANGER = 'border-destructive/40 bg-destructive/[0.12] text-destructive';

/** The review-state badge for a top-level summary. Unknown gh vocabulary passes
 *  through raw with a neutral tone (the UI degrades on drift, no enum fork). */
export function reviewStateBadge(state: string): PrCommentBadge {
  switch (state) {
    case 'APPROVED':
      return { label: 'Approved', className: BADGE_SUCCESS };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', className: BADGE_DANGER };
    case 'COMMENTED':
      return { label: 'Commented', className: BADGE_NEUTRAL };
    case 'DISMISSED':
      return { label: 'Dismissed', className: BADGE_NEUTRAL };
    case 'PENDING':
      return { label: 'Pending', className: BADGE_WARNING };
    default:
      return { label: state, className: BADGE_NEUTRAL };
  }
}

/** How many actionable items the payload carries: unresolved inline threads +
 *  top-level review summaries. Drives the Address button's visibility, its
 *  disabled state, and the confirm copy's count. */
export function actionableCount(comments: PrReviewComments | null): number {
  if (comments === null) return 0;
  return comments.threads.length + comments.reviews.length;
}

/** Address-comments eligibility: there is at least one actionable comment, the
 *  task is not already merged, and no run is in flight (a build/verify session
 *  would collide with the fix run). The `isActionPending` lease is applied by
 *  the shell on top of this. */
export function canAddressComments(task: Task, comments: PrReviewComments | null): boolean {
  if (actionableCount(comments) === 0) return false;
  if (task.merged) return false;
  return task.status !== 'in_progress' && task.status !== 'verifying';
}

/** The ConfirmDialog copy for the Address-comments run — names the count and the
 *  untrusted-input posture (the human gate is never a vague "are you sure"). */
export function addressConfirmCopy(
  count: number,
): { title: string; message: string; confirmLabel: string } {
  return {
    title: 'Address the review comments?',
    message: `Start a fix run to address ${count} review comment${count === 1 ? '' : 's'}? The comments are external input and will be handled as untrusted.`,
    confirmLabel: 'Address comments',
  };
}

/** The thread anchor line: `path:line`, with `(general)` for a thread that has
 *  no path (a detached / PR-level thread) and no suffix when the line is absent
 *  (a file-level or outdated thread). */
export function threadAnchor(path: string | null, line: number | null): string {
  const where = path ?? '(general)';
  return line !== null ? `${where}:${line}` : where;
}

/** Format the web-side receive timestamp for the "Refreshed …" footer line. */
export function formatRefreshedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
