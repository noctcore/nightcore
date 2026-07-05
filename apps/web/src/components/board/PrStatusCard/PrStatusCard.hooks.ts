/** State + derivation helpers for the PrStatusCard: the fetch-on-mount /
 *  manual-refresh status state, the confirm-gated mutation flow, and the
 *  task-coupled visibility/copy helpers. The pure gh-vocabulary →
 *  friendly-label mappers live in `@/lib/pr-status` (shared with the PR Review
 *  workspace) and are re-exported below. NO polling — a fetch happens on
 *  mount, on the Refresh button, and after a successful push; that's it. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PrStatus, Task } from '@/lib/bridge';
import { prStatus } from '@/lib/bridge';

// The pure gh-vocabulary → friendly-label mappers are hoisted to `lib/pr-status`
// (shared with the PR Review workspace); re-exported here so the card shell and
// its tests keep one import site.
export type { PrBadge } from '@/lib/pr-status';
export {
  checksSummary,
  mergeStateLine,
  prStateBadge,
  reviewDecisionBadge,
} from '@/lib/pr-status';

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
 *  story/test seam — when provided (including `null`) no fetch ever fires.
 *  `enabled=false` (a task with no PR yet) renders the inert empty view and
 *  fetches nothing — the OWNER of this hook is TaskDetail, which mounts it for
 *  every open task so the footer can read the fetched state (`pr_status` on a
 *  PR-less task would only error). */
export function usePrStatus(
  taskId: string,
  override?: PrStatus | null,
  enabled: boolean = true,
): PrStatusView {
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // Bumping the epoch re-runs the fetch effect (manual refresh / post-push).
  const [epoch, setEpoch] = useState(0);
  const skip = override !== undefined || !enabled;

  // Task-switch reset (belt — the `key={task.id}` at the render site is the
  // suspenders, and dies if the hook is ever lifted above the keyed node): the
  // hook instance survives a task switch, so task A's snapshot (status/error/
  // refreshedAt) would render — and ARM confirm dialogs — against task B until
  // B's fetch lands. The React render-adjust pattern resets synchronously
  // BEFORE paint (an effect-time reset would still flash one stale frame where
  // a merged-A snapshot arms Finalize against B).
  const [lastTaskId, setLastTaskId] = useState(taskId);
  if (lastTaskId !== taskId) {
    setLastTaskId(taskId);
    setStatus(null);
    setError(null);
    setUnavailable(false);
    setRefreshedAt(null);
  }

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

  // Memoized: the view crosses the memoized TaskDetailChrome as a prop, so its
  // identity must only turn over when the VIEW changes — an unmemoized object
  // literal would re-identify on every stream flush and defeat the chrome memo.
  return useMemo<PrStatusView>(() => {
    if (override !== undefined) {
      return {
        status: override,
        fetching: false,
        error: null,
        unavailable: override === null,
        refreshedAt: null,
        refresh,
      };
    }
    if (!enabled) {
      return {
        status: null,
        fetching: false,
        error: null,
        unavailable: false,
        refreshedAt: null,
        refresh,
      };
    }
    return { status, fetching, error, unavailable, refreshedAt, refresh };
  }, [override, enabled, status, fetching, error, unavailable, refreshedAt, refresh]);
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

/** Push-updates visibility: an OPEN PR with local commits its upstream lacks.
 *  A `null` count means the upstream is UNRESOLVABLE (e.g. pruned after GitHub
 *  auto-deleted a merged head branch) — the button must stay visible: a `-u`
 *  re-push recreates the upstream, so hiding it would funnel the user to
 *  Finalize, the exact wrong direction for possibly-unpushed work. */
export function canPushUpdates(status: PrStatus): boolean {
  return status.state === 'OPEN' && (status.unpushedCommits === null || status.unpushedCommits > 0);
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
      // The count is named only when KNOWN; `null` means the branch's upstream
      // is unresolvable, so the copy says that instead of inventing a number.
      message:
        n !== null
          ? `Push ${n} commit${n === 1 ? '' : 's'} on ${branch} to origin (plain push — never forced). The pull request updates in place.`
          : `Push ${branch} to origin (plain push — never forced). The branch's upstream is missing, so the exact commit count is unknown — the push recreates it. The pull request updates in place.`,
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
    message: `${pullBaseLine(status, task)} Refused if the root is dirty or the pull is not a fast-forward.`,
    confirmLabel: 'Update base',
  };
}

/** The pull-base confirm's first sentence, grounded exactly like the backend
 *  resolves the branch it will act on: the task's persisted base wins; a legacy
 *  task (no persisted base) shows the gh-reported base EXPLICITLY marked as
 *  server-reported; and when both exist but disagree, the mismatch is shown
 *  with the task's base named as the one used — so the dialog can never bless
 *  a different branch than the command mutates. */
export function pullBaseLine(status: PrStatus, task: Task): string {
  const taskBase = task.baseBranch;
  const serverBase = status.baseRefName;
  if (taskBase === undefined || taskBase === '') {
    return `Fast-forward-only pull of ${serverBase} (as reported by GitHub) on the project root.`;
  }
  if (serverBase !== '' && serverBase !== taskBase) {
    return `Fast-forward-only pull of ${taskBase} (the task's recorded base) on the project root — note: GitHub reports the PR's base as ${serverBase}.`;
  }
  return `Fast-forward-only pull of ${taskBase} on the project root.`;
}

/** Format the web-side receive timestamp for the "Refreshed …" footer line. */
export function formatRefreshedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
