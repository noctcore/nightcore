/**
 * The stateful binding over the per-PR FIX registry (`nc:pr-fix`): ONE
 * subscription folds every full-state snapshot into a `Map<fixId, PrFixState>`,
 * reconciled from `list_pr_fixes` on mount. The registry itself is in-memory on
 * the Rust side — an app restart forgets entries (the fix COMMIT survives on the
 * branch), so there is no persisted store to reconcile beyond the live list.
 * The runs sibling is `prreview-runs.hooks.ts`; the PR-workspace view model
 * (`usePrReviewView`) drives both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addressReviewFindings,
  cancelPrFix,
  listPrFixes,
  onPrFixEvent,
  type PrFixState,
  type PrFixStatus,
  pushPrFix,
} from '@/lib/bridge';

/** One `address` outcome: `fixId` set on success; `error` carries a rejection
 *  message (also recorded per-PR in `fixErrors`, but plumbed here so the caller
 *  can toast it synchronously); both `null` when guarded out. */
export interface AddressOutcome {
  fixId: string | null;
  error: string | null;
}

/** One-way lifecycle rank for the equal-`updatedAt` tie-break: two transitions
 *  can share a single millisecond (the Rust dispatch-failure path emits
 *  running→failed in the same ms), and on a timestamp tie the FURTHER-along
 *  status must win. `failed` is terminal — it ranks with `awaiting_push`. */
const FIX_STATUS_RANK: Record<PrFixStatus, number> = {
  running: 0,
  committing: 1,
  awaiting_push: 2,
  failed: 2,
  pushed: 3,
};

/** Rank a (free-string) status. An unknown future status ranks with
 *  `committing` — like it, an intermediate progress state past `running`. */
function fixStatusRank(status: string): number {
  return (FIX_STATUS_RANK as Record<string, number>)[status] ?? 1;
}

export interface UsePrFixesResult {
  /** Every known fix's latest snapshot, keyed by fix id. */
  fixes: ReadonlyMap<string, PrFixState>;
  /** Per-PR address failures, keyed by PR number. An entry clears on that PR's
   *  next successful address; concurrent PRs never clobber each other's error. */
  fixErrors: ReadonlyMap<number, string>;
  /** The PR's displayed fix: the latest by `updatedAt`, or `null` when the
   *  registry knows none for that PR (or the latest one was dismissed). */
  fixForPr: (prNumber: number) => PrFixState | null;
  /** Start a fix run over `findingIds` of review run `runId` on `prNumber`'s
   *  branch. Resolves the new fix id on success; a null `fixId` means guarded
   *  out (no project / empty selection / a fix already running or starting for
   *  this PR) or rejected — a rejection also carries its message as `error`
   *  (and lands in `fixErrors`). Different PRs may fix concurrently; the SAME
   *  PR cannot double-start. */
  address: (
    prNumber: number,
    runId: string,
    findingIds: string[],
  ) => Promise<AddressOutcome>;
  /** Push an `awaiting_push` fix's branch — the human-gated publish. Rejects on
   *  failure so the caller's confirm gate can surface the error inline. */
  push: (fixId: string) => Promise<void>;
  /** Cancel a running fix (it lands as `failed("cancelled")` on the channel).
   *  Rejects on failure so the caller can surface it. */
  cancel: (fixId: string) => Promise<void>;
  /** Hide a failed fix's card, LOCAL-ONLY: the registry entry survives (and a
   *  later fix for the same PR shows normally under its new id). */
  dismiss: (fixId: string) => void;
}

/**
 * Own the per-PR fix registry: subscribe ONCE to `nc:pr-fix`, fold every
 * full-state snapshot into the map (newer `updatedAt` wins, so a stale
 * `list_pr_fixes` read can never downgrade a live event that beat it), and
 * reconcile against the Rust in-memory registry on mount / project arrival.
 */
export function usePrFixes(hasProject: boolean): UsePrFixesResult {
  const [fixes, setFixes] = useState<ReadonlyMap<string, PrFixState>>(
    () => new Map(),
  );
  const [fixErrors, setFixErrors] = useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  /** Locally-hidden failed fixes (the card's "dismiss"); never sent to Rust. */
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Synchronous per-PR re-entrancy guard, mirroring the runs hook: a second
  // `address` for the SAME PR in the render-timing gap (before the running
  // snapshot lands and the UI disables its button) is a no-op instead of a
  // second paid run. A ref — not state — so the check can't race a pending
  // render. Distinct PRs are never blocked by each other.
  const addressingPrs = useRef<Set<number>>(new Set());
  // The latest rendered map, for synchronous already-running checks in
  // `address` (state reads inside a callback can be a render behind).
  const fixesRef = useRef(fixes);
  fixesRef.current = fixes;

  /** Fold one snapshot in: replace unless the held entry is strictly newer (a
   *  stale list read racing a live event must not win). On an EQUAL
   *  `updatedAt` the further-along lifecycle status wins — the lifecycle is
   *  one-way, and same-ms transition pairs exist (the Rust dispatch-failure
   *  path), so a late-arriving earlier status must not undo a terminal one. */
  const upsert = useCallback((incoming: PrFixState) => {
    setFixes((prev) => {
      const existing = prev.get(incoming.id);
      if (existing !== undefined) {
        if (existing.updatedAt > incoming.updatedAt) return prev;
        if (
          existing.updatedAt === incoming.updatedAt &&
          fixStatusRank(existing.status) >= fixStatusRank(incoming.status)
        ) {
          return prev;
        }
      }
      const next = new Map(prev);
      next.set(incoming.id, incoming);
      return next;
    });
  }, []);

  // Mount (and project-arrival) reconcile against the Rust in-memory registry.
  // Defensive `Array.isArray`: the browser fallback is `[]`, but mocked seams
  // may resolve `undefined` for unhandled commands.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listPrFixes();
      if (cancelled || !Array.isArray(list)) return;
      for (const state of list) upsert(state);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasProject, upsert]);

  // Subscribe ONCE to the live channel. Every snapshot folds into its own fix's
  // entry — `upsert` is identity-stable, so this installs once.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const fn = await onPrFixEvent(upsert);
      if (disposed) fn();
      else unlisten = fn;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [upsert]);

  const fixForPr = useCallback(
    (prNumber: number): PrFixState | null => {
      let best: PrFixState | null = null;
      for (const fix of fixes.values()) {
        if (fix.prNumber !== prNumber) continue;
        if (best === null || fix.updatedAt > best.updatedAt) best = fix;
      }
      if (best === null) return null;
      // A dismissed latest hides the strip entirely — an OLDER fix must not
      // resurface behind it (that would read as time going backwards).
      return dismissedIds.has(best.id) ? null : best;
    },
    [fixes, dismissedIds],
  );

  const address = useCallback(
    async (
      prNumber: number,
      runId: string,
      findingIds: string[],
    ): Promise<AddressOutcome> => {
      if (!hasProject || runId.length === 0 || findingIds.length === 0) {
        return { fixId: null, error: null };
      }
      // Guard the SAME PR against a double-start: synchronously via the
      // in-flight ref (the double-click window), and against the rendered map
      // (a fix already running). The backend additionally refuses a second
      // running fix per PR atomically in its registry.
      if (addressingPrs.current.has(prNumber)) return { fixId: null, error: null };
      for (const fix of fixesRef.current.values()) {
        if (fix.prNumber === prNumber && fix.status === 'running') {
          return { fixId: null, error: null };
        }
      }
      addressingPrs.current.add(prNumber);
      try {
        const fixId = await addressReviewFindings(runId, findingIds);
        setFixErrors((prev) => {
          if (!prev.has(prNumber)) return prev;
          const next = new Map(prev);
          next.delete(prNumber);
          return next;
        });
        return { fixId, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFixErrors((prev) => new Map(prev).set(prNumber, message));
        return { fixId: null, error: message };
      } finally {
        addressingPrs.current.delete(prNumber);
      }
    },
    [hasProject],
  );

  const push = useCallback(async (fixId: string) => {
    await pushPrFix(fixId);
  }, []);

  const cancel = useCallback(async (fixId: string) => {
    await cancelPrFix(fixId);
  }, []);

  const dismiss = useCallback((fixId: string) => {
    setDismissedIds((prev) => new Set(prev).add(fixId));
  }, []);

  return { fixes, fixErrors, fixForPr, address, push, cancel, dismiss };
}
