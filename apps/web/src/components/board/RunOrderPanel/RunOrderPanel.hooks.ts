import { useMemo } from 'react';

import { type ArmPreview, armPreview, useRunOrder } from '../run-order';
import type { RunOrderPanelProps, RunOrderRow } from './RunOrderPanel.types';
import { runOrderRows, unreachableRows } from './RunOrderPanel.utils';

/** Everything the run-order sheet renders. */
export interface RunOrderPanelView {
  /** The ordered rows (backend order, ids resolved to titles). */
  rows: RunOrderRow[];
  /** Launchable tasks with no reachable position (missing/failed dep, or a cycle). */
  unreachable: { id: string; title: string }[];
  /** The shared arm-preview summary — the same line the Auto Mode popover shows. */
  preview: ArmPreview;
  /** Live slot context, for the "N of M slots free" header line. */
  freeSlots: number;
  maxConcurrency: number;
}

/** Drive the run-order sheet (#402). Reads the projection from context and joins it with
 *  the task list; the ORDER is never recomputed here — the Rust `run_order` command owns it
 *  (its wave 0 is pinned to the auto-loop tick's own slice by a Rust parity test). */
export function useRunOrderPanel({ tasks }: Pick<RunOrderPanelProps, 'tasks'>): RunOrderPanelView {
  const projection = useRunOrder();
  const rows = useMemo(() => runOrderRows(projection, tasks), [projection, tasks]);
  const unreachable = useMemo(() => unreachableRows(projection, tasks), [projection, tasks]);
  return {
    rows,
    unreachable,
    preview: armPreview(projection),
    freeSlots: projection.freeSlots,
    maxConcurrency: projection.maxConcurrency,
  };
}
