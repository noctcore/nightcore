/** The single run-enable decision shared by the board card and the detail drawer.
 *
 *  Before T13 the two disagreed: the card's Run/Retry gated only on `blocked` (so it
 *  happily launched a run in parallel), while the drawer refused whenever ANY task was
 *  running ("another task is already running") even though concurrency defaults to 3.
 *  Both are now one slot-aware gate that mirrors what the backend actually enforces —
 *  `submit_run` leases a slot and rejects when none is free at the configured
 *  concurrency.
 *
 *  The board-wide "is a run slot free?" boolean travels by context ({@link RunGateContext})
 *  rather than as a prop threaded through Board → Column → card: it derives from the live
 *  concurrency (which the chrome context owns) and the running-task count, and it flips
 *  only when slot availability crosses the concurrency line — so subscribing cards
 *  re-render only on that flip, not on every run start/stop. */
import { createContext, createElement, type ReactNode, useContext } from 'react';

/** The result of the run gate: whether the action is enabled and, when not, a
 *  human-readable reason for the button's tooltip/label. */
export interface RunGate {
  enabled: boolean;
  reason: string | null;
}

/** Whether a task's manual Run/Retry is allowed right now. A task can start when it
 *  isn't blocked by an unfinished dependency AND a run slot is free at the configured
 *  concurrency (`slotsFree`). Pure. */
export function canRunTask(input: { blocked: boolean; slotsFree: boolean }): RunGate {
  if (input.blocked) {
    return { enabled: false, reason: 'Blocked by an unfinished dependency' };
  }
  if (!input.slotsFree) {
    return {
      enabled: false,
      reason: 'All run slots are busy — wait for a run to finish or raise concurrency',
    };
  }
  return { enabled: true, reason: null };
}

/** The board-wide run-slot availability the card + drawer read for their run gate. */
export interface RunSlots {
  /** True when a run slot is free at the configured concurrency (`runningCount < concurrency`). */
  slotsFree: boolean;
}

/** Carries the board-wide run-slot availability to the cards + drawer. `null` = no
 *  provider above; {@link useRunGate} then defaults to slots-free so presentational
 *  stories/tests (which mount a card without the board shell) keep Run enabled. */
export const RunGateContext = createContext<RunSlots | null>(null);

/** Provide the (memoized) run-slot availability to a subtree. A plain-`.ts` provider
 *  (feature-root module, not a component folder), so it renders via `createElement`. */
export function RunGateProvider({
  value,
  children,
}: {
  value: RunSlots;
  children: ReactNode;
}) {
  return createElement(RunGateContext.Provider, { value }, children);
}

/** Read the board-wide run-slot availability. Defaults to slots-free when there's no
 *  provider above (a card rendered outside the board shell in a story/test), so the gate
 *  never spuriously disables Run there. */
export function useRunGate(): RunSlots {
  return useContext(RunGateContext) ?? { slotsFree: true };
}
