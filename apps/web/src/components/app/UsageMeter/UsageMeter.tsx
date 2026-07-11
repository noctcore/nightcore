/** The sidebar-footer provider usage widget (issue #121): a compact per-provider
 *  utilization bar + reset countdown, a detail popover on click, and the dormant
 *  "Enable usage meter" opt-in affordance. A thin shell over `useUsageMeter` — all
 *  fetch/subscribe/enable/cost state lives in the colocated hook (spec §3.11). */
import { AnimatePresence, BoltIcon, ProviderIcon, providerLabel } from '@/components/ui';
import type { ProviderUsage } from '@/lib/bridge';

import {
  compactWindows,
  LIVE_USAGE_SOURCE,
  useUsageMeter,
  windowSummary,
} from './UsageMeter.hooks';
import type { CostState, UsageMeterProps } from './UsageMeter.types';
import { STATUS_META, UsageMeterPopover, WindowBar } from './UsageMeterPopover';

/** Icon/text tint for a provider glyph by its peak utilization (collapsed rail). */
function iconTone(peakPercent: number): string {
  if (peakPercent >= 85) return 'text-destructive';
  if (peakPercent >= 60) return 'text-warning';
  return 'text-success';
}

/** The dormant opt-in affordance shown until the user enables the meter (spec
 *  decision 5). Clicking fires the credential read (Keychain prompt) + first poll. */
function EnableButton({ collapsed, onEnable }: { collapsed: boolean; onEnable: () => void }) {
  return (
    <div className="border-t border-border px-3 py-2.5">
      <button
        type="button"
        onClick={onEnable}
        title="Enable usage meter"
        aria-label="Enable usage meter"
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground ${collapsed ? 'justify-center' : ''}`}
      >
        <BoltIcon size={14} className="shrink-0" />
        {!collapsed && <span className="text-[11.5px] font-medium">Enable usage meter</span>}
      </button>
    </div>
  );
}

/** The compact content of a connected/degraded row: the status badge + up to two
 *  utilization bars (or a one-line hint for a state with no windows). */
function RowBody({ row, now }: { row: ProviderUsage; now: number }) {
  const meta = STATUS_META[row.status];
  const bars = compactWindows(row.windows);
  const dim = row.stale || row.status === 'rateLimited';
  return (
    <>
      <div className="flex items-center gap-2">
        <ProviderIcon provider={row.provider} size={12} className="shrink-0 text-muted-foreground" />
        <span className="text-[11.5px] font-medium text-foreground">{providerLabel(row.provider)}</span>
        {meta.badge !== null && (
          <span className={`ml-auto font-mono text-[9px] uppercase tracking-[0.06em] ${meta.tone}`}>
            {meta.badge}
          </span>
        )}
      </div>
      {bars.length > 0 ? (
        <div className={`mt-1.5 flex flex-col gap-1.5 ${dim ? 'opacity-50' : ''}`}>
          {bars.map((win) => (
            <WindowBar key={win.kind} win={win} now={now} />
          ))}
        </div>
      ) : (
        row.status === 'unauthorized' && (
          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
            Session expired — run <code className="font-mono">{row.provider}</code> to re-sign-in.
          </p>
        )
      )}
    </>
  );
}

/** One provider's footer row: the compact body + the click-to-open detail popover.
 *  A not-connected provider is a dormant, non-interactive muted row (spec decision
 *  3); every other state is a button that opens the popover. */
function ProviderRow({
  row,
  now,
  collapsed,
  open,
  cost,
  onToggle,
  onClose,
}: {
  row: ProviderUsage;
  now: number;
  collapsed: boolean;
  open: boolean;
  cost: CostState;
  onToggle: () => void;
  onClose: () => void;
}) {
  const label = providerLabel(row.provider);

  if (row.status === 'notConnected') {
    return collapsed ? (
      <div title={`${label} — not connected`} className="flex justify-center opacity-40">
        <ProviderIcon provider={row.provider} size={16} className="text-muted-foreground" />
      </div>
    ) : (
      <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground/70">
        <ProviderIcon provider={row.provider} size={12} className="shrink-0" />
        <span>{label} — not connected</span>
      </div>
    );
  }

  const peak = Math.max(0, ...compactWindows(row.windows).map((w) => w.usedPercent));
  const dimmed = row.stale || row.status === 'rateLimited' || row.status === 'unsupported';
  // The collapsed-rail hover tooltip: the compact-window summary ("Claude — 5h 12%
  // · weekly 72%") when there are windows, else just the peak — shown immediately on
  // hover via the group-hover idiom (not the slow native `title` reveal).
  const summary = windowSummary(row.windows);
  const railTip = summary !== '' ? `${label} — ${summary}` : `${label} · ${Math.round(peak)}%`;

  return (
    <div className="relative">
      {collapsed ? (
        <button
          type="button"
          onClick={onToggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={railTip}
          className="group/usage relative flex w-full justify-center rounded-lg py-1 transition-colors hover:bg-white/[0.04]"
        >
          <ProviderIcon
            provider={row.provider}
            size={16}
            className={dimmed ? 'text-muted-foreground' : iconTone(peak)}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] font-medium text-popover-foreground opacity-0 shadow-lg transition-all duration-200 group-hover/usage:translate-x-0 group-hover/usage:opacity-100"
          >
            {railTip}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
        >
          <RowBody row={row} now={now} />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <UsageMeterPopover
            row={row}
            cost={cost}
            now={now}
            collapsed={collapsed}
            onClose={onClose}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The provider usage meter widget, mounted in the sidebar footer (both the unified
 * and classic layouts, via `NavSidebar`). Renders the opt-in "Enable" affordance
 * until the meter is enabled, then a dormant/degraded/active row per provider.
 * Returns `null` until the first snapshot resolves, so the footer never flashes a
 * wrong state.
 */
export function UsageMeter({ collapsed, source = LIVE_USAGE_SOURCE }: UsageMeterProps) {
  const view = useUsageMeter(source);
  const now = Date.now();

  if (view.meter === null) return null;
  if (!view.enabled) return <EnableButton collapsed={collapsed} onEnable={view.enable} />;

  return (
    <div className="border-t border-border px-3 py-2.5">
      {!collapsed && (
        <div className="mb-1.5 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
          Usage
        </div>
      )}
      <div className={`flex flex-col ${collapsed ? 'items-center gap-1.5' : 'gap-1'}`}>
        {view.meter.providers.map((row) => (
          <ProviderRow
            key={row.provider}
            row={row}
            now={now}
            collapsed={collapsed}
            open={view.openProvider === row.provider}
            cost={view.costFor(row.provider)}
            onToggle={() => view.toggleProvider(row.provider)}
            onClose={view.closePopover}
          />
        ))}
      </div>
    </div>
  );
}
