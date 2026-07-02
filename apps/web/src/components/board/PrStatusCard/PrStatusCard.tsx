/** Live pull-request status card for TaskDetail (PR phase 2). Fetch-on-mount +
 *  manual refresh only (no polling); every mutation is human-gated behind the
 *  shared ConfirmDialog and executes through the AppShell's guarded handlers.
 *  Thin shell — all state/effects live in `PrStatusCard.hooks.ts`. */
import {
  BranchIcon,
  Button,
  ConfirmDialog,
  GithubIcon,
  RetryIcon,
  Spinner,
  UploadIcon,
} from '@/components/ui';

import {
  canFinalize,
  canPullBase,
  canPushUpdates,
  checksSummary,
  confirmCopy,
  formatRefreshedAt,
  mergeStateLine,
  prStateBadge,
  reviewDecisionBadge,
  usePrConfirm,
  usePrStatus,
} from './PrStatusCard.hooks';
import type { PrStatusCardProps } from './PrStatusCard.types';

/** Shared chip classes for the state/review badges (tone comes from the hook). */
const BADGE_BASE =
  'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]';

export function PrStatusCard({
  task,
  onOpenPr,
  onPushUpdates,
  onFinalize,
  onPullBase,
  isActionPending,
  statusOverride,
}: PrStatusCardProps) {
  const view = usePrStatus(task.id, statusOverride);
  const confirm = usePrConfirm(task.id, view.refresh, onPushUpdates, onFinalize, onPullBase);
  const { status } = view;
  const pending = (action: string): boolean => isActionPending?.(action, task.id) ?? false;

  const state = status !== null ? prStateBadge(status) : null;
  const review = status !== null ? reviewDecisionBadge(status) : null;
  const mergeLine = status !== null ? mergeStateLine(status) : null;
  const checks = status !== null ? checksSummary(status) : null;
  // Prefer the freshly-fetched gh-reported page URL; fall back to the persisted
  // one so the chip works before the first fetch lands.
  const prUrl = status?.url ?? task.prUrl ?? null;

  return (
    <section className="rounded-md border border-border bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2">
        {status !== null && state !== null ? (
          <>
            <span className={`${BADGE_BASE} ${state.className}`}>{state.label}</span>
            {review !== null && (
              <span className={`${BADGE_BASE} ${review.className}`}>{review.label}</span>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {view.fetching
              ? 'Fetching PR status…'
              : view.unavailable
                ? 'PR status is unavailable in the browser preview.'
                : view.error !== null
                  ? 'PR status failed to load.'
                  : 'PR status not loaded yet.'}
          </span>
        )}
        <span className="flex-1" />
        {prUrl !== null && onOpenPr !== undefined && (
          <Button
            variant="ghost"
            onClick={() => onOpenPr(prUrl)}
            title="Open the pull request in your browser"
          >
            <GithubIcon size={13} />
            {status !== null ? `#${status.number}` : 'PR'} ↗
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={view.refresh}
          disabled={view.fetching}
          aria-busy={view.fetching}
        >
          {view.fetching ? <Spinner size={14} /> : <RetryIcon size={14} />}
          Refresh
        </Button>
      </div>

      {status !== null && (mergeLine !== null || checks !== null || canPushUpdates(status)) && (
        <div className="mt-2 space-y-1 text-xs">
          {mergeLine !== null && <p className="text-foreground/90">{mergeLine}</p>}
          {checks !== null && (
            <p className="font-mono tabular-nums">
              <span className="text-success">{checks.passed} passed</span>
              <span className="text-muted-foreground"> · </span>
              <span className={checks.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                {checks.failed} failed
              </span>
              <span className="text-muted-foreground"> · </span>
              <span className={checks.pending > 0 ? 'text-warning' : 'text-muted-foreground'}>
                {checks.pending} pending
              </span>
            </p>
          )}
          {canPushUpdates(status) && (
            <p className="text-muted-foreground">
              {status.unpushedCommits} local commit{status.unpushedCommits === 1 ? '' : 's'} not
              on the pull request yet.
            </p>
          )}
        </div>
      )}

      {view.error !== null && <p className="mt-2 text-xs text-destructive">{view.error}</p>}

      {status !== null &&
        ((canPushUpdates(status) && onPushUpdates !== undefined) ||
          (canFinalize(status, task) && onFinalize !== undefined) ||
          (canPullBase(status, task) && onPullBase !== undefined)) && (
          <div className="mt-2.5 flex items-center gap-2">
            {canPushUpdates(status) && onPushUpdates !== undefined && (
              <Button
                variant="secondary"
                onClick={() => confirm.arm('push')}
                disabled={pending('pushPrUpdates')}
                aria-busy={pending('pushPrUpdates')}
              >
                {pending('pushPrUpdates') ? <Spinner size={14} /> : <UploadIcon size={14} />}
                Push updates ({status.unpushedCommits})
              </Button>
            )}
            {canFinalize(status, task) && onFinalize !== undefined && (
              <Button
                onClick={() => confirm.arm('finalize')}
                disabled={pending('finalizePr')}
                aria-busy={pending('finalizePr')}
              >
                {pending('finalizePr') ? <Spinner size={14} /> : <BranchIcon size={14} />}
                Finalize
              </Button>
            )}
            {canPullBase(status, task) && onPullBase !== undefined && (
              <Button
                variant="secondary"
                onClick={() => confirm.arm('pullBase')}
                disabled={pending('pullBaseFf')}
                aria-busy={pending('pullBaseFf')}
              >
                {pending('pullBaseFf') ? <Spinner size={14} /> : <BranchIcon size={14} />}
                Update base branch
              </Button>
            )}
          </div>
        )}

      {view.refreshedAt !== null && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          Refreshed {formatRefreshedAt(view.refreshedAt)}
        </p>
      )}

      {confirm.arming !== null && status !== null && (
        <ConfirmDialog
          {...confirmCopy(confirm.arming, status, task)}
          onConfirm={confirm.confirm}
          onCancel={confirm.cancel}
        />
      )}
    </section>
  );
}
