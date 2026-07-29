/** The board's run-order seam (#402): the coordinator's PROJECTED execution order,
 *  delivered to the cards, the header, and the Auto-Mode popover by context.
 *
 *  Why context and not props: the board's `BoardProps` and `ColumnProps` contracts both
 *  sit exactly at the 12-member cap (`noctcore-react/max-props-per-component`), and a
 *  per-card ordinal would have to be threaded Board → Column → TaskCard through a
 *  virtualized list. A card reads its own position by id instead, which also means
 *  virtualization can mount/unmount rows freely without the ordering breaking.
 *
 *  VOLATILITY: the projection is refetched on `nc:task` / `nc:loop` (trailing-debounced
 *  in the shell), never on a per-frame `nc:session` flush — the same cadence as the
 *  blocked-id set — so providing it through context cannot defeat the board's memo
 *  economy. The value is memoized in the shell hook.
 *
 *  HONESTY: the ordering comes from the Rust `run_order` command, which reuses the
 *  auto-loop tick's own primitives (a Rust parity test pins wave 0 to the exact slice
 *  the tick launches). Nothing here re-derives the order — this module only indexes and
 *  formats it. */
import { createContext, createElement, type ReactNode, useContext } from 'react';

import type { RunOrderEntry, RunOrderProjection } from '@/lib/bridge';
import { pluralize } from '@/lib/formatters';

/** A stable empty projection: the default when no provider is above (presentational
 *  stories/tests) and the shell's pre-fetch seed. Module-level so it never re-identifies
 *  and churns the memoized card tree. */
export const EMPTY_RUN_ORDER: RunOrderProjection = {
  entries: [],
  unreachable: [],
  freeSlots: 0,
  maxConcurrency: 0,
  startsNowCount: 0,
};

/** Carries the projected run order to the board subtree. `null` = no provider above;
 *  {@link useRunOrder} then falls back to {@link EMPTY_RUN_ORDER} so a card rendered
 *  outside the board shell simply shows no ordering hint (never a wrong one). */
export const RunOrderContext = createContext<RunOrderProjection | null>(null);

/** Provide the (shell-memoized) run-order projection to a subtree. A plain-`.ts`
 *  provider (feature-root module, not a component folder), so it renders via
 *  `createElement` rather than JSX. */
export function RunOrderProvider({
  value,
  children,
}: {
  value: RunOrderProjection;
  children: ReactNode;
}) {
  return createElement(RunOrderContext.Provider, { value }, children);
}

/** Read the projected run order. Falls back to the empty projection outside a provider,
 *  so stories/tests that mount a card standalone render without ordering chrome. */
export function useRunOrder(): RunOrderProjection {
  return useContext(RunOrderContext) ?? EMPTY_RUN_ORDER;
}

/** Index a projection's entries by task id, for a card's O(1) self-lookup. Pure. */
export function runOrderIndex(projection: RunOrderProjection): Map<string, RunOrderEntry> {
  return new Map(projection.entries.map((entry) => [entry.taskId, entry]));
}

/** The tasks the projection expects to run, in order — the "next up" list. Pure
 *  (the entries already arrive ordered; this is the named accessor the panel reads so
 *  callers never re-sort and risk inventing a second ordering). */
export function nextUp(projection: RunOrderProjection, limit: number): RunOrderEntry[] {
  return projection.entries.slice(0, Math.max(0, limit));
}

/** The Auto-Mode ARM PREVIEW (#402): what arming the loop right now would do, answered
 *  BEFORE the click. `startsNow` is the count the very next tick launches (wave 0 of the
 *  projection = `min(freeSlots, eligible)`); `queued` is everything else the loop will
 *  work through as slots free up; `stuck` is the launchable tasks that can never become
 *  eligible as the board stands (a missing/failed dependency, or a cycle).
 *
 *  `summary` is the one-line label the toolbar tooltip and the popover both render, so
 *  the two can never disagree. Pure. */
export interface ArmPreview {
  startsNow: number;
  queued: number;
  stuck: number;
  /** True when there is nothing at all for the loop to pick up. */
  idle: boolean;
  summary: string;
}

export function armPreview(projection: RunOrderProjection): ArmPreview {
  const startsNow = projection.startsNowCount;
  const queued = projection.entries.length - startsNow;
  const stuck = projection.unreachable.length;
  const idle = projection.entries.length === 0 && stuck === 0;
  if (idle) {
    return { startsNow, queued, stuck, idle, summary: 'Nothing queued to run' };
  }
  const parts: string[] = [
    startsNow === 0
      ? 'Starts nothing right now'
      : `Starts ${pluralize(startsNow, 'task')} now`,
  ];
  if (queued > 0) parts.push(`${queued} then queued`);
  if (stuck > 0) parts.push(`${pluralize(stuck, 'task')} blocked`);
  return { startsNow, queued, stuck, idle, summary: parts.join(' · ') };
}
