/** The board-chrome seam: the low-churn header/banner cluster (appearance +
 *  auto-loop) the shell owns, delivered to the Board and its `BoardHeader`
 *  through context instead of a dozen drilled props.
 *
 *  VOLATILITY: every value here changes only on loop events (`nc:loop`),
 *  settings writes, or a project switch — never on a per-frame `nc:session`
 *  stream flush — so providing them through context cannot defeat the board's
 *  memo economy. Stream-flush-volatile values must NEVER enter this context. */
import { createContext, createElement, type ReactNode, useContext } from 'react';

import type { BoardAppearance } from '@/lib/bridge';

import type { PickedBackgroundImage } from './BoardBackgroundPanel';
import type { UsageHotWindow } from './usage-hot';

/** A tripped circuit breaker: the autonomous loop paused after consecutive
 *  failures. Drives the board's dismissable Resume banner. */
export interface BreakerInfo {
  /** Consecutive-failure count that tripped the breaker (`failureThreshold`). */
  failureThreshold: number;
}

/** Everything the board chrome (header toolbar, its popovers, and the breaker
 *  banner) reads from the shell: the per-project appearance cluster and the
 *  autonomous-loop cluster. */
export interface BoardChromeValue {
  /** This project's raw board-appearance override (Custom Background), or `null`
   *  when it hasn't been customized — the board normalizes it to the defaults. */
  appearanceOverride: BoardAppearance | null;
  /** This project's background image `version` (cache-bust key), or `null` when
   *  no custom background is set. */
  backgroundVersion: number | null;
  /** Persist a board-appearance knob change (the panel sends the full next set). */
  onChangeAppearance: (next: BoardAppearance) => void;
  /** Persist a newly picked background image. */
  onPickBackground: (image: PickedBackgroundImage) => Promise<void> | void;
  /** Clear the current background image. */
  onClearBackground: () => Promise<void> | void;
  /** Live max-concurrency (from `nc:loop`, falling back to persisted settings). */
  concurrency: number;
  /** Whether the autonomous loop is running (reflects `nc:loop`, not local state). */
  autoMode: boolean;
  /** Auto Mode option: auto-commit each task once it's verified (persisted). */
  autoCommitOnVerified: boolean;
  /** Usage-aware throttle (spec 2026-07-11): the % at which Auto Mode stops picking
   *  up new runs. 50..=100, persisted; drives the gear-popover slider. */
  autoPauseUsageThreshold: number;
  /** Whether the usage meter is enabled — the throttle (and its slider) only
   *  function when it is (decision 4). Renders the slider disabled + hinted when off. */
  usageMeterEnabled: boolean;
  /** Set when the loop is usage-paused (spec 2026-07-11): the hottest window ≥ the
   *  threshold on the run provider, for the board's dismissable pause banner; `null`
   *  when not usage-paused. */
  usagePause: UsageHotWindow | null;
  /** Set when the circuit breaker tripped; drives the Resume banner. */
  breaker: BreakerInfo | null;
  /** Start/stop the autonomous loop (the header Auto Mode toggle). */
  onToggleAutoMode: () => void;
  /** Persist the auto-commit-on-verified Auto Mode option (the gear popover). */
  onAutoCommitChange: (next: boolean) => void;
  /** Persist the usage-throttle threshold (the gear popover slider). */
  onThresholdChange: (next: number) => void;
  /** Resize the live agent pool (the header concurrency slider). */
  onConcurrencyChange: (n: number) => void;
  /** Resume the loop after a circuit-breaker pause. */
  onResume: () => void;
}

/** Carries the shell's board-chrome cluster to the Board + BoardHeader.
 *  `null` = no provider above; {@link useBoardChrome} throws. */
export const BoardChromeContext = createContext<BoardChromeValue | null>(null);

/** Provide the shell's (memoized) board-chrome value to a subtree. A plain-`.ts`
 *  provider (feature-root module, not a component folder), so it renders via
 *  `createElement` rather than JSX. */
export function BoardChromeProvider({
  value,
  children,
}: {
  value: BoardChromeValue;
  children: ReactNode;
}) {
  return createElement(BoardChromeContext.Provider, { value }, children);
}

/** Read the shell's board-chrome cluster. Throws outside a provider so a missing
 *  wiring fails loudly in dev/test instead of rendering dead header controls. */
export function useBoardChrome(): BoardChromeValue {
  const value = useContext(BoardChromeContext);
  if (value === null) {
    throw new Error('useBoardChrome must be used within a <BoardChromeProvider>.');
  }
  return value;
}
