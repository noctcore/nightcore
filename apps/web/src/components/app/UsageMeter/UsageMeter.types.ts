import type { UsageCost, UsageMeter } from '@/lib/bridge';

/**
 * The data seam for the sidebar usage widget: the read/enable/refresh commands + a
 * lazy cost scan + the `nc:usage` subscription, bundled so stories and tests drive
 * every status without Tauri (the ProviderConfigPanel `data`-seam idiom). The live
 * seam (`LIVE_USAGE_SOURCE`) wraps the real bridge; a fixture seam resolves
 * in-memory snapshots.
 */
export interface UsageSource {
  /** Fetch the last-good snapshot (the fetch-on-mount source of truth). */
  getUsage: () => Promise<UsageMeter>;
  /** The opt-in gesture: flip the flag, prime credentials, arm the poll loop. */
  enable: () => Promise<UsageMeter>;
  /** Kick a fresh poll (the `window` focus listener; staleness-guarded Rust-side). */
  refresh: () => Promise<void>;
  /** The lazy per-provider LOCAL cost estimate, fetched when a popover opens. */
  getCost: (provider: string) => Promise<UsageCost>;
  /** Subscribe to live `nc:usage` snapshots. Resolves an unlisten function. */
  subscribe: (handler: (meter: UsageMeter) => void) => Promise<() => void>;
}

/** Props for the sidebar-footer usage widget. */
export interface UsageMeterProps {
  /** Collapsed 66-px rail: render icon-only per-provider dots (spec §3.11). */
  collapsed: boolean;
  /** The data seam. Defaults to the live bridge; stories inject a fixture. */
  source?: UsageSource;
}

/** The lazy cost-scan lifecycle for one provider's detail popover (fetched on the
 *  popover's first open, then cached for the widget's lifetime). */
export type CostState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly cost: UsageCost }
  | { readonly status: 'error' };
