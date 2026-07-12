/** Usage settings cards (AUTOMATION group) — split from settings-cards to stay under
 *  the file-size ratchet, mirroring settings-github-cards. Fixes the usage-meter
 *  dead end: `disableUsageMeter` was exposed on the bridge but had zero web call
 *  sites, so an opted-in user had no way to opt back out.
 *
 *  Issue #305: the toggle used to read/write `settings.usageMeterEnabled` directly,
 *  disconnected from the sidebar widget's own live `nc:usage`-derived state — a
 *  toggle from one surface never reached the other. It now binds to the shared
 *  `usageMeter` signal (`useUsageMeterEnabled`, seeded from settings then kept live
 *  by the same `nc:usage` push the Rust enable/disable commands emit), so both
 *  surfaces reconcile. `patchGlobal({ usageMeterEnabled })` still fires alongside it
 *  — NOT as a second source of truth for the toggle (the Rust command already flips
 *  the persisted flag as part of `enable`/`disable_usage_meter`), but to mirror the
 *  value into the web's cached `Settings` object, which other readers key off
 *  directly (the board-header Auto-Mode gear's `AutoModeOptions`, which isn't wired
 *  to the live signal). */
import { NumberField, PerfIcon, Toggle } from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';
import type { UsageMeterEnabledState } from '@/lib/useUsageMeterEnabled';

import type { SettingsCardProps } from './SettingsCard';

/** Clamp the throttle to its 50..=100 window (mirrors the Rust patch-merge clamp and
 *  the board-header gear's own slider) so a stray commit can never persist out of range. */
function clampThreshold(n: number): number {
  return Math.min(100, Math.max(50, Math.round(n)));
}

/** Toggle the usage meter through the shared signal: `enable`/`disable` fire the
 *  real Rust command for its side effects (Keychain read + poll-arm on enable, kick
 *  + park on disable) and flip `usageMeter.enabled` once it resolves; `patchGlobal`
 *  then mirrors the flag into the web's cached `Settings` object (see module doc). */
function toggleUsageMeter(
  next: boolean,
  usageMeter: UsageMeterEnabledState,
  patchGlobal: (patch: SettingsPatch) => void,
): void {
  void (next ? usageMeter.enable() : usageMeter.disable())
    .then(() => patchGlobal({ usageMeterEnabled: next }))
    .catch((err) => {
      console.error(`${next ? 'enable' : 'disable'}_usage_meter failed`, err);
    });
}

/** Build the Usage page cards: the meter opt-in/out + the Auto-Mode pause threshold. */
export function buildUsageCards(
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
  usageMeter: UsageMeterEnabledState,
): SettingsCardProps[] {
  return [
    {
      icon: <PerfIcon size={18} />,
      title: 'Provider usage meter',
      subtitle: 'Read-only rate-limit visibility for the sidebar and Auto Mode.',
      rows: [
        {
          label: 'Usage meter',
          hint: 'Reads OAuth credentials to show Claude/Codex rate-limit windows (read-only; may prompt for Keychain access). Off by default.',
          control: (
            <Toggle
              on={usageMeter.enabled}
              onChange={(next) => toggleUsageMeter(next, usageMeter, patchGlobal)}
              label="Enable provider usage meter"
            />
          ),
        },
        {
          label: 'Pause Auto Mode at usage (%)',
          hint: usageMeter.enabled
            ? 'When any rate-limit window reaches this level, Auto Mode stops picking up new runs until usage cools. Range 50–100, default 90.'
            : 'Enable the usage meter above to use this.',
          control: (
            <NumberField
              value={settings.autoPauseUsageThreshold}
              placeholder="90"
              min={50}
              step="1"
              ariaLabel="Pause Auto Mode at usage threshold (percent)"
              onCommit={(n) => patchGlobal({ autoPauseUsageThreshold: clampThreshold(n) })}
            />
          ),
        },
      ],
    },
  ];
}
