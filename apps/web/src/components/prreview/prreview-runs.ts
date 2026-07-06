/**
 * The per-PR run REGISTRY over the PR Review event stream: a pure reducer that
 * routes every `pr-review-*` event into its own run's `ReviewStream` (keyed by
 * `runId`), plus the pure selectors a per-PR workspace surface reads it through.
 *
 * This is the concurrent-runs foundation the singleton binding lacks: where the
 * current `usePrReview` drops any event whose `runId` isn't the one active run
 * (`event.runId !== activeRunId.current`), the registry folds every run
 * independently — events for runs started before mount CREATE their entry
 * instead of being dropped, and two PRs may review at once.
 *
 * Pure module: no React, no bridge calls. The stateful binding lives in the
 * sibling `prreview-runs.hooks.ts`.
 */
import type { PrReviewEvent, PrReviewRun } from '@/lib/bridge';
import { patchStreamItem } from '@/lib/scan-run';

import {
  EMPTY_REVIEW_STREAM,
  foldReview,
  type ReviewStream,
  streamFromRun,
} from './prreview-stream';

/** One registry entry: a run's folded stream plus the recency ordinal the
 *  selectors order by. `startedAt` is epoch-ms on one axis for BOTH sources —
 *  persisted runs seed it from `createdAt`, live-created entries from the
 *  fold's `now` — so "newest" compares across them without a second clock. */
export interface PrReviewRunEntry {
  stream: ReviewStream;
  startedAt: number;
}

/** The registry: every known run's live stream, keyed by `runId`. Treated as
 *  immutable — `foldRegistry` / `reconcileRegistryRun` return a new map. */
export type PrReviewRunRegistry = ReadonlyMap<string, PrReviewRunEntry>;

/** The empty registry (the hook's initial state and a test seed). */
export const EMPTY_RUN_REGISTRY: PrReviewRunRegistry = new Map();

/**
 * Fold one `pr-review-*` event into the registry, routing it to its run's
 * stream via `foldReview`. An event for an unknown `runId` (a run started
 * before mount) CREATES its entry — seeded as a running stream carrying the
 * event's `runId`, since only `pr-review-started` sets `runId` inside the
 * per-run fold. The convert acknowledgement (`pr-review-finding-converted`)
 * marks the finding on its run in place, mirroring the singleton's special
 * case; for an unknown run it is a no-op (there is no finding to mark — the
 * hook's persisted reconcile owns that state).
 *
 * @param now the recency ordinal stamped on a newly created entry (epoch-ms).
 *   Defaults to the wall clock; tests pass it explicitly for determinism.
 */
export function foldRegistry(
  prev: PrReviewRunRegistry,
  event: PrReviewEvent,
  now: number = Date.now(),
): PrReviewRunRegistry {
  if (event.type === 'pr-review-finding-converted') {
    const entry = prev.get(event.runId);
    if (entry === undefined) return prev;
    const next = new Map(prev);
    next.set(event.runId, {
      ...entry,
      stream: patchStreamItem(entry.stream, {
        runId: event.runId,
        itemId: event.findingId,
        items: (s) => s.findings,
        write: (s, findings) => ({ ...s, findings }),
        patch: (f) => ({
          ...f,
          status: 'converted' as const,
          linkedTaskId: event.taskId,
        }),
      }),
    });
    return next;
  }
  const entry: PrReviewRunEntry = prev.get(event.runId) ?? {
    stream: { ...EMPTY_REVIEW_STREAM, runId: event.runId, status: 'running' },
    startedAt: now,
  };
  const next = new Map(prev);
  next.set(event.runId, { ...entry, stream: foldReview(entry.stream, event) });
  return next;
}

/** Replace (or insert) a run's registry entry with its authoritative persisted
 *  projection (`streamFromRun`). The hook applies this on mount and on the
 *  terminal `pr-review-completed` / `pr-review-failed` events — the store wins
 *  over the live fold, and the entry's ordinal becomes the run's `createdAt`.
 *  ONE exception: a terminal (completed/failed) stream is never replaced by a
 *  NON-terminal projection — a slow mount list can resolve after the run's
 *  terminal event already reconciled, and letting its stale `running` snapshot
 *  win would stick the run at "running" forever (no later event re-reconciles,
 *  and `start()` refuses a "running" PR). The run lifecycle is one-way, so the
 *  terminal entry is always the fresher truth. */
export function reconcileRegistryRun(
  prev: PrReviewRunRegistry,
  run: PrReviewRun,
): PrReviewRunRegistry {
  const stream = streamFromRun(run);
  const held = prev.get(run.id)?.stream.status;
  const heldTerminal = held === 'completed' || held === 'failed';
  const incomingTerminal =
    stream.status === 'completed' || stream.status === 'failed';
  if (heldTerminal && !incomingTerminal) return prev;
  const next = new Map(prev);
  next.set(run.id, { stream, startedAt: run.createdAt });
  return next;
}

/**
 * The stream a PR's workspace surface displays: a RUNNING run wins outright
 * (live activity beats any finished run, however recent; the newest running one
 * if several), else the newest entry by `startedAt`. `null` when the registry
 * knows no run for that PR — note a live run whose `pr-review-started` arrived
 * without an optimistic entry carries `prNumber: null` until its persisted
 * reconcile lands, so it is invisible to per-PR selectors until then.
 */
export function latestRunForPr(
  streams: PrReviewRunRegistry,
  prNumber: number,
): ReviewStream | null {
  let best: PrReviewRunEntry | null = null;
  for (const entry of streams.values()) {
    if (entry.stream.prNumber !== prNumber) continue;
    if (best === null) {
      best = entry;
      continue;
    }
    const bestRunning = best.stream.status === 'running';
    const entryRunning = entry.stream.status === 'running';
    if (entryRunning !== bestRunning) {
      if (entryRunning) best = entry;
      continue;
    }
    if (entry.startedAt > best.startedAt) best = entry;
  }
  return best?.stream ?? null;
}

/** The distinct PR numbers with a run currently in flight (concurrent-run
 *  affordances: list badges, "reviewing…" chips). */
export function runningPrNumbers(streams: PrReviewRunRegistry): number[] {
  const out = new Set<number>();
  for (const entry of streams.values()) {
    if (entry.stream.status === 'running' && entry.stream.prNumber !== null) {
      out.add(entry.stream.prNumber);
    }
  }
  return [...out];
}

/** OPEN findings of the PR's latest COMPLETED run — the workspace badge count.
 *  Running/failed runs don't count (their findings are provisional or void);
 *  `0` when no completed run is known for the PR. */
export function findingCountForPr(
  streams: PrReviewRunRegistry,
  prNumber: number,
): number {
  let best: PrReviewRunEntry | null = null;
  for (const entry of streams.values()) {
    if (entry.stream.prNumber !== prNumber) continue;
    if (entry.stream.status !== 'completed') continue;
    if (best === null || entry.startedAt > best.startedAt) best = entry;
  }
  if (best === null) return 0;
  return best.stream.findings.filter((f) => f.status === 'open').length;
}

/** The persisted run history for one PR. The store lists runs newest-first;
 *  the filter preserves that order. */
export function historyForPr(
  runs: PrReviewRun[],
  prNumber: number,
): PrReviewRun[] {
  return runs.filter((run) => run.prNumber === prNumber);
}
