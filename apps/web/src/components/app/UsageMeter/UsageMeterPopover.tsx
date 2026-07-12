/** Presentational pieces for the usage widget: the shared utilization bar, the
 *  per-status badge vocabulary, and the click-to-open detail popover (all windows +
 *  credits + the lazy local cost estimate). No state lives here — the open flag and
 *  cost lifecycle are owned by `useUsageMeter`; this file only renders them. */
import {
  ClockIcon,
  m,
  popover,
  ProviderIcon,
  providerLabel,
  Spinner,
} from '@/components/ui';
import type { ProviderUsage, RateWindow, UsageStatus } from '@/lib/bridge';
import { formatCostUsd, formatCountdown, formatRelativeTime } from '@/lib/formatters';

import { barTone } from './UsageMeter.hooks';
import type { CostState } from './UsageMeter.types';

/** The per-status badge label + tint the row and popover header render. `ok` shows
 *  no badge (the bars carry the signal); every degraded state names itself. */
export const STATUS_META: Record<UsageStatus, { readonly badge: string | null; readonly tone: string }> = {
  ok: { badge: null, tone: 'text-success' },
  stale: { badge: 'stale', tone: 'text-muted-foreground' },
  rateLimited: { badge: 'rate-limited', tone: 'text-warning' },
  unauthorized: { badge: 'sign in', tone: 'text-warning' },
  notConnected: { badge: 'not connected', tone: 'text-muted-foreground' },
  unsupported: { badge: 'unavailable', tone: 'text-muted-foreground' },
  disabled: { badge: null, tone: 'text-muted-foreground' },
};

/** One rate-limit window as a labeled utilization bar + a "resets in …" countdown.
 *  `dim` fades it for a `stale`/`rateLimited` provider (showing last-good). */
export function WindowBar({
  win,
  now,
  dim = false,
}: {
  win: RateWindow;
  now: number;
  dim?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, win.usedPercent));
  const countdown = win.resetsAt != null ? formatCountdown(win.resetsAt, now) : '';
  return (
    <div className={dim ? 'opacity-50' : ''}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-3xs text-muted-foreground">{win.label}</span>
        <span className="shrink-0 font-mono text-3xs text-muted-foreground">
          {Math.round(pct)}%
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full ${barTone(pct)}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-label={win.label}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {countdown !== '' && (
        <div className="mt-0.5 flex items-center gap-1 text-4xs text-muted-foreground/70">
          <ClockIcon size={9} />
          resets in {countdown}
        </div>
      )}
    </div>
  );
}

/** "updated 5m ago" / "updated just now" — the last-successful-fetch stamp. */
function updatedLabel(updatedAt: string, now: number): string {
  const rel = formatRelativeTime(updatedAt, now);
  if (rel === '') return '';
  return rel === 'just now' ? 'updated just now' : `updated ${rel} ago`;
}

/** The credits line (Codex `credits` / Claude `extra_usage`): a balance, an
 *  unlimited marker, or a plain "credits available" — popover-only. */
function CreditsLine({ credits }: { credits: NonNullable<ProviderUsage['credits']> }) {
  if (credits.unlimited === true) {
    return <span className="text-2xs text-muted-foreground">Credits: unlimited</span>;
  }
  if (credits.balance != null) {
    const amount = formatCostUsd(credits.balance);
    return (
      <span className="text-2xs text-muted-foreground">
        Credits: {credits.currency != null ? `${amount} ${credits.currency}` : amount}
      </span>
    );
  }
  if (credits.hasCredits === true) {
    return <span className="text-2xs text-muted-foreground">Credits available</span>;
  }
  return null;
}

/** The local cost estimate row — always labeled approximate (spec §3.8). */
function CostLine({ cost }: { cost: CostState }) {
  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-3xs uppercase tracking-[0.1em] text-muted-foreground/70">
          Est. cost
        </span>
        {cost.status === 'loading' && <Spinner size={11} />}
        {cost.status === 'error' && (
          <span className="text-2xs text-muted-foreground">unavailable</span>
        )}
        {cost.status === 'ready' && (
          <span className="font-mono text-2xs text-foreground">
            {cost.cost.costUsd != null ? `≈ ${formatCostUsd(cost.cost.costUsd)}` : '—'}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-4xs leading-snug text-muted-foreground/60">
        ≈ approximate, from local session logs
      </p>
    </div>
  );
}

/** The click-to-open detail popover for one provider: every window, credits, and
 *  the lazily-scanned local cost. Positions itself above the row (expanded) or to
 *  the right (collapsed rail). A transparent backdrop closes it on outside-click. */
export function UsageMeterPopover({
  row,
  cost,
  now,
  collapsed,
  onClose,
}: {
  row: ProviderUsage;
  cost: CostState;
  now: number;
  collapsed: boolean;
  onClose: () => void;
}) {
  const meta = STATUS_META[row.status];
  return (
    <>
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <m.div
        variants={popover}
        initial="initial"
        animate="animate"
        exit="exit"
        role="dialog"
        aria-label={`${providerLabel(row.provider)} usage detail`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        style={{ transformOrigin: collapsed ? 'left bottom' : 'bottom center' }}
        className={
          collapsed
            ? 'absolute bottom-0 left-full z-50 ml-2 w-64 rounded-xl border border-border bg-popover p-3 shadow-2xl'
            : 'absolute bottom-full left-0 right-0 z-50 mb-2 rounded-xl border border-border bg-popover p-3 shadow-2xl'
        }
      >
        <div className="mb-2 flex items-center gap-2">
          <ProviderIcon provider={row.provider} size={14} className="text-muted-foreground" />
          <span className="text-xs-plus font-semibold">{providerLabel(row.provider)}</span>
          {meta.badge !== null && (
            <span className={`ml-auto font-mono text-4xs-plus uppercase tracking-[0.06em] ${meta.tone}`}>
              {meta.badge}
            </span>
          )}
        </div>

        {row.message != null && (
          <p className="mb-2 text-2xs leading-snug text-muted-foreground">{row.message}</p>
        )}

        {row.windows.length > 0 ? (
          <div className="flex flex-col gap-2">
            {row.windows.map((win) => (
              <WindowBar key={win.kind} win={win} now={now} dim={row.stale} />
            ))}
          </div>
        ) : (
          row.message == null && (
            <p className="text-2xs text-muted-foreground">No usage windows reported.</p>
          )
        )}

        {row.credits != null && (
          <div className="mt-2">
            <CreditsLine credits={row.credits} />
          </div>
        )}

        {row.updatedAt != null && (
          <p className="mt-2 text-4xs text-muted-foreground/60">{updatedLabel(row.updatedAt, now)}</p>
        )}

        <CostLine cost={cost} />
      </m.div>
    </>
  );
}
