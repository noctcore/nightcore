import { useMemo } from 'react';

import type {
  BoardChromeValue,
  PickedBackgroundImage,
  UsageHotWindow,
} from '@/components/board';
import type { BoardAppearance } from '@/lib/bridge';

import type { useAutoLoop } from './useAutoLoop.hooks';
import type { useSettingsData } from './useSettingsData.hooks';

/** The Settings default for the usage-throttle threshold — mirrors the Rust
 *  `default_usage_pause_threshold` (90) so a not-yet-loaded settings snapshot reads
 *  the same value the backend gate uses. */
export const DEFAULT_USAGE_PAUSE_THRESHOLD = 90;

/** The Board header's four project-scoped chrome handlers (appearance/background +
 *  the auto-commit Auto Mode option), pre-assembled into one referentially stable
 *  group so `memo(Board)` bails on a stream flush instead of re-reconciling the
 *  board + all six columns each frame from four fresh inline arrows. */
export interface BoardChromeActions {
  /** Persist a board-appearance knob change for the active project. */
  onChangeAppearance: (next: BoardAppearance) => void;
  /** Persist a newly picked background image for the active project. */
  onPickBackground: (image: PickedBackgroundImage) => Promise<void> | void;
  /** Clear the active project's background image. */
  onClearBackground: () => Promise<void> | void;
  /** Persist the auto-commit-on-verified Auto Mode option (global setting). */
  onAutoCommitChange: (next: boolean) => void;
  /** Persist the usage-throttle threshold (global setting; clamped 50..=100). */
  onThresholdChange: (next: number) => void;
}

/** Assemble the board-chrome cluster (appearance override/version + the four
 *  appearance handlers + the auto-loop cluster) delivered to the Board and its
 *  `BoardHeader` via `BoardChromeProvider`. Extracted from `useAppShell` so the shell
 *  composition hook stays thin. Every source is low-churn — the appearance handlers
 *  (project switch / settings-callback change), the `nc:loop`-driven auto-loop fields,
 *  and settings-write values — so the result re-identifies only on a loop event, a
 *  settings write, or a project switch, never on a per-frame `nc:session` flush, and
 *  so cannot defeat the board's memo economy. */
export function useBoardChromeValue(
  activeProjectId: string | null,
  settings: ReturnType<typeof useSettingsData>,
  autoLoop: ReturnType<typeof useAutoLoop>,
  usageHot: UsageHotWindow | null,
): BoardChromeValue {
  const {
    update: applySettings,
    setBackground: applyBackground,
    clearBackground: applyClearBackground,
  } = settings;
  const appearance = useMemo<BoardChromeActions>(
    () => ({
      onChangeAppearance: (next) => {
        if (activeProjectId === null) return;
        applySettings({ projectId: activeProjectId, boardAppearance: next });
      },
      onPickBackground: (image) =>
        activeProjectId === null ? undefined : applyBackground(activeProjectId, image),
      onClearBackground: () =>
        activeProjectId === null ? undefined : applyClearBackground(activeProjectId),
      onAutoCommitChange: (next) => applySettings({ autoCommitOnVerified: next }),
      onThresholdChange: (next) => applySettings({ autoPauseUsageThreshold: next }),
    }),
    [activeProjectId, applySettings, applyBackground, applyClearBackground],
  );

  // The active project's persisted board-appearance override + background version
  // (or null when unset / no active project) — read from settings, folded into the
  // chrome value the header's Background panel + the board surface consume.
  const projectOverride =
    activeProjectId === null ? undefined : settings.settings?.projectOverrides[activeProjectId];
  const appearanceOverride = projectOverride?.boardAppearance ?? null;
  const backgroundVersion = projectOverride?.boardBackground?.version ?? null;
  const autoCommitOnVerified = settings.settings?.autoCommitOnVerified ?? false;
  const autoPauseUsageThreshold =
    settings.settings?.autoPauseUsageThreshold ?? DEFAULT_USAGE_PAUSE_THRESHOLD;
  const usageMeterEnabled = settings.settings?.usageMeterEnabled ?? false;
  // The pause banner shows ONLY when the loop actually reports a usage pause
  // (`nc:loop` reason 'usage'); the window specifics come from the live `nc:usage`
  // snapshot. So the banner is null unless the loop is usage-paused AND the snapshot
  // still shows a hot window — both must agree, matching the backend gate.
  const usagePause = autoLoop.usagePaused ? usageHot : null;

  return useMemo<BoardChromeValue>(
    () => ({
      appearanceOverride,
      backgroundVersion,
      onChangeAppearance: appearance.onChangeAppearance,
      onPickBackground: appearance.onPickBackground,
      onClearBackground: appearance.onClearBackground,
      concurrency: autoLoop.concurrency,
      autoMode: autoLoop.autoMode,
      autoCommitOnVerified,
      autoPauseUsageThreshold,
      usageMeterEnabled,
      usagePause,
      breaker: autoLoop.breaker,
      onToggleAutoMode: autoLoop.toggleAutoMode,
      onAutoCommitChange: appearance.onAutoCommitChange,
      onThresholdChange: appearance.onThresholdChange,
      onConcurrencyChange: autoLoop.changeConcurrency,
      onResume: autoLoop.resume,
    }),
    [
      appearanceOverride,
      backgroundVersion,
      appearance,
      autoLoop.concurrency,
      autoLoop.autoMode,
      autoCommitOnVerified,
      autoPauseUsageThreshold,
      usageMeterEnabled,
      usagePause,
      autoLoop.breaker,
      autoLoop.toggleAutoMode,
      autoLoop.changeConcurrency,
      autoLoop.resume,
    ],
  );
}
