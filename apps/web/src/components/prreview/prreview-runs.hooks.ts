/**
 * The stateful binding over the per-PR run registry (`prreview-runs.ts`): ONE
 * `nc:pr-review` subscription folds every live event into the registry (no
 * active-run drop-gate — concurrent runs fold independently), and the persisted
 * store reconciles it on mount and on each run's terminal event. This is the
 * registry replacement for the old singleton `usePrReview` binding; the
 * PR-workspace view model (`usePrReviewView`) drives everything through it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelPrReview,
  type EffortLevel,
  getPrReviewRun,
  listPrReviewRuns,
  onPrReviewEvent,
  type PrReviewRun,
  type ReviewLens,
  startPrReview,
} from '@/lib/bridge';
import { seedStepState } from '@/lib/scan-run';

import {
  EMPTY_RUN_REGISTRY,
  foldRegistry,
  historyForPr,
  latestRunForPr,
  type PrReviewRunRegistry,
  reconcileRegistryRun,
} from './prreview-runs';
import {
  EMPTY_REVIEW_STREAM,
  type ReviewStream,
  streamFromRun,
} from './prreview-stream';

/** Per-run launch options, mirroring `startPrReview`'s optional knobs. */
export interface StartPrReviewOptions {
  model?: string | null;
  effort?: EffortLevel | null;
}

/** One PR's slice of the registry — what a workspace row/panel renders. */
export interface PrRunView {
  /** The PR's display stream (a running run wins, else the newest), or `null`
   *  when no run is known for this PR. */
  stream: ReviewStream | null;
  /** Persisted run history for this PR, newest first. */
  history: PrReviewRun[];
  /** True when this PR has a run in flight (drives the disabled run button). */
  isRunning: boolean;
}

export interface UsePrReviewRunsResult {
  /** The live registry: every known run's stream, keyed by `runId`. */
  registry: PrReviewRunRegistry;
  /** Persisted runs across ALL PRs, newest first (store-capped at 50). */
  runs: PrReviewRun[];
  /** Per-PR start failures, keyed by PR number. An entry clears on that PR's
   *  next successful start; concurrent PRs never clobber each other's error. */
  startErrors: ReadonlyMap<number, string>;
  /** Start a review run for `prNumber`. Resolves the new `runId`, or `null`
   *  when guarded out (no project / empty lenses / this PR already starting or
   *  running) or when the start rejected (the error lands in `startErrors`).
   *  Different PRs may run concurrently; the SAME PR cannot double-start. */
  start: (
    prNumber: number,
    lenses: ReviewLens[],
    options?: StartPrReviewOptions,
  ) => Promise<string | null>;
  /** Cancel an in-flight run by id (aborts every lens pass). */
  cancel: (runId: string) => Promise<void>;
  /** Fetch a persisted run and project it into the registry (authoritative).
   *  Resolves the projected stream, or `null` when the run doesn't exist. */
  selectRun: (runId: string) => Promise<ReviewStream | null>;
  /** One PR's registry slice: display stream + persisted history + running flag. */
  byPr: (prNumber: number) => PrRunView;
  /** Re-list persisted runs (updates `runs`); returns the fresh list. */
  refreshRuns: () => Promise<PrReviewRun[]>;
}

/**
 * Own the per-PR run registry: subscribe ONCE to `nc:pr-review`, fold every
 * live event into its run's stream, and reconcile against the persisted store
 * on mount and on terminal events — so a remount recovers mid-flight runs with
 * their accumulated findings (`streamFromRun`) and their live events keep
 * folding on top (NO drop-gate, unlike the singleton `usePrReview`).
 */
export function usePrReviewRuns(hasProject: boolean): UsePrReviewRunsResult {
  const [registry, setRegistry] =
    useState<PrReviewRunRegistry>(EMPTY_RUN_REGISTRY);
  const [runs, setRuns] = useState<PrReviewRun[]>([]);
  const [startErrors, setStartErrors] = useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );

  // Synchronous per-PR re-entrancy guard: a second `start` for the SAME PR in
  // the render-timing gap (before the optimistic running entry lands and the
  // UI disables its button) is a no-op instead of a second paid run. A ref —
  // not state — so the check can't race a pending render. Distinct PRs are
  // never blocked by each other.
  const startingPrs = useRef<Set<number>>(new Set());
  // The latest rendered registry, for synchronous already-running checks in
  // `start` (state reads inside a callback can be a render behind).
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const refreshRuns = useCallback(async () => {
    const next = await listPrReviewRuns();
    setRuns(next);
    return next;
  }, []);

  /** Authoritative per-run reconcile: replace the run's folded stream with the
   *  persisted projection, then refresh the run list. */
  const reconcileRun = useCallback(
    async (runId: string) => {
      const run = await getPrReviewRun(runId);
      if (run !== null) setRegistry((prev) => reconcileRegistryRun(prev, run));
      await refreshRuns();
    },
    [refreshRuns],
  );

  // Mount (and project-arrival) reconcile: project EVERY persisted run into the
  // registry. Running runs appear with their accumulated findings; their live
  // events then keep folding on top of the projection — the mid-run recovery
  // path a remount depends on.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const persisted = await refreshRuns();
      if (cancelled) return;
      setRegistry((prev) => {
        let next = prev;
        for (const run of persisted) next = reconcileRegistryRun(next, run);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [hasProject, refreshRuns]);

  // Subscribe ONCE to the live stream. Every event folds into its OWN run's
  // entry (unknown runIds create one — runs started before mount keep
  // streaming), and each run's terminal event triggers its persisted reconcile.
  // `refreshRuns`/`reconcileRun` are identity-stable, so this installs once.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const fn = await onPrReviewEvent((event) => {
        setRegistry((prev) => foldRegistry(prev, event));
        if (event.type === 'pr-review-finding-converted') {
          // The lifecycle mark is folded above; the persisted run changed too.
          void refreshRuns();
          return;
        }
        if (
          event.type === 'pr-review-completed' ||
          event.type === 'pr-review-failed'
        ) {
          void reconcileRun(event.runId);
        }
      });
      if (disposed) fn();
      else unlisten = fn;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshRuns, reconcileRun]);

  const start = useCallback(
    async (
      prNumber: number,
      lenses: ReviewLens[],
      options: StartPrReviewOptions = {},
    ): Promise<string | null> => {
      if (!hasProject || lenses.length === 0 || prNumber <= 0) return null;
      // Guard the SAME PR against a double-start: synchronously via the
      // in-flight ref (the double-click window), and against the rendered
      // registry (a run already streaming). The backend additionally rejects
      // deeper races on its own in-flight guard.
      if (startingPrs.current.has(prNumber)) return null;
      if (latestRunForPr(registryRef.current, prNumber)?.status === 'running') {
        return null;
      }
      startingPrs.current.add(prNumber);
      try {
        const model = options.model ?? null;
        const runId = await startPrReview(prNumber, lenses, {
          model,
          effort: options.effort ?? null,
        });
        // Optimistic running entry until `pr-review-started` lands. Carries the
        // PR number (the started event omits it; the per-run fold preserves it
        // across the started reset) so per-PR selectors see the run immediately.
        const optimistic: ReviewStream = {
          ...EMPTY_REVIEW_STREAM,
          runId,
          status: 'running',
          prNumber,
          model,
          requestedLenses: lenses,
          lensState: seedStepState(lenses),
        };
        setRegistry((prev) => {
          // Live events can race ahead of the command resolution and create
          // (and advance) this run's entry inside the IPC window — the
          // optimistic seed must never overwrite that folded progress.
          if (prev.has(runId)) return prev;
          const next = new Map(prev);
          next.set(runId, { stream: optimistic, startedAt: Date.now() });
          return next;
        });
        setStartErrors((prev) => {
          if (!prev.has(prNumber)) return prev;
          const next = new Map(prev);
          next.delete(prNumber);
          return next;
        });
        void refreshRuns();
        return runId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStartErrors((prev) => new Map(prev).set(prNumber, message));
        return null;
      } finally {
        startingPrs.current.delete(prNumber);
      }
    },
    [hasProject, refreshRuns],
  );

  const cancel = useCallback(async (runId: string) => {
    await cancelPrReview(runId);
  }, []);

  const selectRun = useCallback(
    async (runId: string): Promise<ReviewStream | null> => {
      const run = await getPrReviewRun(runId);
      if (run === null) return null;
      setRegistry((prev) => reconcileRegistryRun(prev, run));
      return streamFromRun(run);
    },
    [],
  );

  const byPr = useCallback(
    (prNumber: number): PrRunView => {
      const stream = latestRunForPr(registry, prNumber);
      return {
        stream,
        history: historyForPr(runs, prNumber),
        isRunning: stream !== null && stream.status === 'running',
      };
    },
    [registry, runs],
  );

  return {
    registry,
    runs,
    startErrors,
    start,
    cancel,
    selectRun,
    byPr,
    refreshRuns,
  };
}
