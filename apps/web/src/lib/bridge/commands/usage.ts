/** Bridge commands — the provider usage meter (issue #121). Thin wrappers over the
 *  `enable_usage_meter` / `disable_usage_meter` / `get_usage` / `refresh_usage` /
 *  `get_usage_cost` Tauri commands: a read-only telemetry poller that lives in the
 *  Rust core (it owns the Keychain + HTTP + credential-file seams). Outside the
 *  Tauri webview (browser preview / stories) they resolve quiet fallbacks so the
 *  sidebar widget degrades to its dormant "Enable usage meter" state instead of
 *  rejecting. */
import { tauriInvoke } from '../internal';
import type { UsageCost, UsageMeter, UsageStatus } from '../types';

/** The provider vocabulary the Rust registry pins (`usage::registry::PROVIDERS`) —
 *  used only to synthesize the browser-preview fallback meters below. */
const PREVIEW_PROVIDERS = ['claude', 'codex'] as const;

/** A synthesized meter with every provider in `status` — the browser-preview
 *  fallback for the read commands, mirroring the Rust `disabled_meter` /
 *  cold-registry shapes so the widget renders a stable layout without Tauri. */
function previewMeter(status: UsageStatus): UsageMeter {
  return {
    providers: PREVIEW_PROVIDERS.map((provider) => ({
      provider,
      status,
      windows: [],
      stale: false,
    })),
  };
}

/** The last-good snapshot (the widget's fetch-on-mount source of truth; no fetch
 *  Rust-side). Returns an all-`disabled` meter outside Tauri so the widget shows
 *  its opt-in "Enable usage meter" state in the browser preview. */
export async function getUsage(): Promise<UsageMeter> {
  return tauriInvoke<UsageMeter>('get_usage', {}, previewMeter('disabled'));
}

/** Opt in (spec decision 5): flips the persisted flag, performs the FIRST
 *  credential read (so the macOS Keychain prompt is a consequence of the click),
 *  arms the poll loop, and returns the initial snapshot. Outside Tauri it resolves
 *  an all-`notConnected` meter so the preview leaves the "Enable" state. */
export async function enableUsageMeter(): Promise<UsageMeter> {
  return tauriInvoke<UsageMeter>('enable_usage_meter', {}, previewMeter('notConnected'));
}

/** Opt out: flip the flag off; the Rust poll loop parks on the enable-kick. */
export async function disableUsageMeter(): Promise<void> {
  await tauriInvoke<null>('disable_usage_meter', {}, null);
}

/** Kick a fresh poll (the widget's `window` focus listener). Single-flight-guarded
 *  and internally no-ops unless the snapshot is ≥ 10 min stale, so a focus-storm
 *  can't hammer the endpoints. */
export async function refreshUsage(): Promise<void> {
  await tauriInvoke<null>('refresh_usage', {}, null);
}

/** The on-demand LOCAL cost estimate for a provider (spec §3.8) — invoked lazily
 *  when the detail popover opens, never on the 10-min poll. Always labeled
 *  approximate. Outside Tauri it resolves a null-cost estimate. */
export async function getUsageCost(provider: string): Promise<UsageCost> {
  return tauriInvoke<UsageCost>(
    'get_usage_cost',
    { provider },
    { provider, approximate: true, computedAt: new Date().toISOString() },
  );
}
