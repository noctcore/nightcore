/**
 * The Board→scan provenance-navigation effect, hoisted out of the four scan
 * siblings (Insight / Harness / Scorecard / PR-Review). A task's `sourceRef` chip
 * routes here with a run + item to open: the target is consumed FIRST (so it can
 * never refire), the view drops any reconfigure/peek/selection state, lands on
 * that run's RESULTS, then opens the item's detail panel. A deleted run/item
 * degrades to the current stream with no panel — never an error.
 *
 * `apps/web/src/lib/` is the only place the `no-cross-feature-imports` lint permits
 * cross-family sharing, so this lives here alongside `useScanRun`.
 */
import { useEffect, useRef } from 'react';

import type { ScanTarget } from './source-ref';

/** The per-family bits injected into {@link usePreselectNavigation}. */
export interface PreselectNavigationConfig {
  /** The pending navigation target, or `null`/`undefined` when there is none. */
  preselect: ScanTarget | null | undefined;
  /** Acknowledge the target so routing clears it (it never refires). */
  onPreselectConsumed?: () => void;
  /** Load the target run and display its RESULTS (the scan `selectRun`). */
  selectRun: (runId: string) => Promise<void>;
  /**
   * Synchronous view resets applied before the run loads — e.g. dropping the
   * reconfigure/peek/selection/bulk state so the RESULTS screen renders clean.
   */
  onEnter?: () => void;
  /**
   * Open the target item once its run is loaded. Receives the full target so the
   * family can branch on `kind` (Harness opens a proposal vs a convention finding).
   */
  onOpenItem: (target: ScanTarget) => void;
}

/**
 * Run the provenance-navigation effect. The config is read through a ref so the
 * effect only re-fires when the `preselect` target (or the stable `selectRun`)
 * changes — a fresh `onEnter` / `onOpenItem` closure every render never re-fires
 * it (which would double-invoke `selectRun`).
 */
export function usePreselectNavigation(config: PreselectNavigationConfig): void {
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const { preselect, selectRun } = config;

  useEffect(() => {
    if (preselect === null || preselect === undefined) return;
    const { onPreselectConsumed, onEnter, onOpenItem } = cfgRef.current;
    onPreselectConsumed?.();
    onEnter?.();
    void (async () => {
      await selectRun(preselect.runId);
      onOpenItem(preselect);
    })();
  }, [preselect, selectRun]);
}
