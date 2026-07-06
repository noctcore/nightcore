/**
 * The shared per-item lifecycle triple (dismiss / restore / convert-to-task),
 * hoisted out of the scan view data hooks that had each cloned the same three
 * callbacks: guard on the displayed run, fire the bridge command, re-project or
 * optimistically mark the stream, then `refreshRuns`. Insight uses all three;
 * Harness instantiates it per item family (findings / proposals / artifacts);
 * Scorecard uses only `convert` (its "harden" action).
 *
 * `apps/web/src/lib/` is the only place the `no-cross-feature-imports` lint
 * permits cross-family sharing, so this lives here alongside `useScanRun`.
 */
import { type Dispatch, type SetStateAction, useCallback, useRef } from 'react';

import type { Task } from '@/lib/bridge';

/** The per-family configuration injected into {@link useScanItemActions}. */
export interface ScanItemActionsConfig<
  Run,
  Stream extends { runId: string | null },
  Item extends { id: string },
> {
  /** The displayed run's id (`stream.runId`); `null` guards every action out. */
  runId: string | null;
  setStream: Dispatch<SetStateAction<Stream>>;
  /** Re-list persisted runs (the shared `useScanRun` API's `refreshRuns`). */
  refreshRuns: () => Promise<Run[]>;
  /** Project a persisted run into the stream shape (dismiss/restore re-project). */
  streamFromRun: (run: Run) => Stream;
  /** Read the item list off the stream (e.g. `s.findings`). */
  items: (s: Stream) => Item[];
  /** Write the item list back (e.g. `(s, findings) => ({ ...s, findings })`). */
  writeItems: (s: Stream, items: Item[]) => Stream;
  /** The bridge dismiss command; returns the updated run (or `null`). */
  dismissItem?: (runId: string, itemId: string) => Promise<Run | null>;
  /** The bridge restore command; returns the updated run (or `null`). */
  restoreItem?: (runId: string, itemId: string) => Promise<Run | null>;
  /** The convert-to-task pair: the bridge command plus the optimistic mark
   *  applied from the returned task (the command returns a `Task`, not a run;
   *  the family's `*-converted` notice idempotently applies the same flip). */
  convert?: {
    run: (runId: string, itemId: string) => Promise<Task>;
    mark: (item: Item, taskId: string) => Item;
  };
}

/** The identity-stable actions {@link useScanItemActions} exposes. */
export interface ScanItemActions {
  /** Dismiss an item and re-project the returned run. No-op when unconfigured. */
  dismiss: (itemId: string) => Promise<void>;
  /** Restore a dismissed item and re-project the returned run. */
  restore: (itemId: string) => Promise<void>;
  /** Convert an item into a board task (idempotent). Resolves the task, or
   *  `null` when guarded out / unconfigured. */
  convert: (itemId: string) => Promise<Task | null>;
}

/**
 * Own the dismiss/restore/convert item actions for one scan item family. The
 * config is read through a ref so the callbacks stay identity-stable across
 * renders while always acting on the currently displayed run.
 */
export function useScanItemActions<
  Run,
  Stream extends { runId: string | null },
  Item extends { id: string },
>(config: ScanItemActionsConfig<Run, Stream, Item>): ScanItemActions {
  const cfgRef = useRef(config);
  cfgRef.current = config;

  const dismiss = useCallback(async (itemId: string) => {
    const { runId, dismissItem, setStream, streamFromRun, refreshRuns } =
      cfgRef.current;
    if (runId === null || dismissItem === undefined) return;
    const run = await dismissItem(runId, itemId);
    if (run !== null) setStream(streamFromRun(run));
    await refreshRuns();
  }, []);

  const restore = useCallback(async (itemId: string) => {
    const { runId, restoreItem, setStream, streamFromRun, refreshRuns } =
      cfgRef.current;
    if (runId === null || restoreItem === undefined) return;
    const run = await restoreItem(runId, itemId);
    if (run !== null) setStream(streamFromRun(run));
    await refreshRuns();
  }, []);

  const convert = useCallback(async (itemId: string): Promise<Task | null> => {
    const { runId, convert: convertCfg, setStream, items, writeItems, refreshRuns } =
      cfgRef.current;
    if (runId === null || convertCfg === undefined) return null;
    const task = await convertCfg.run(runId, itemId);
    // Optimistic flip from the returned task id; the family's `*-converted`
    // notice idempotently applies the same flip for any other open view.
    setStream((prev) =>
      writeItems(
        prev,
        items(prev).map((i) => (i.id === itemId ? convertCfg.mark(i, task.id) : i)),
      ),
    );
    await refreshRuns();
    return task;
  }, []);

  return { dismiss, restore, convert };
}
