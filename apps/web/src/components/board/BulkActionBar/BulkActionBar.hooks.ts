import { useCallback, useMemo } from 'react';

import type { MenuItem } from '@/components/ui';
import type { Task, TaskStatus } from '@/lib/bridge';

import { useTaskActions } from '../actions';
import { useRunOrder } from '../run-order';
import {
  chainEdits,
  selectedInLaunchOrder,
  unchainEdits,
  useTaskSelection,
} from '../selection';
import { COLUMNS } from '../status';
import type { BulkActionBarProps } from './BulkActionBar.types';

/** A bulk verb's enabled/disabled decision, with the reason for the disabled tooltip —
 *  the board never hides a verb, it explains why it can't run (the same discipline the
 *  card's Run gate and the drawer's Create PR button use). */
export interface BulkVerb {
  enabled: boolean;
  reason: string | null;
  run: () => void;
}

/** Everything the bar renders. */
export interface BulkActionBarView {
  /** Number of selected tasks (0 ⇒ the bar renders nothing). */
  count: number;
  /** Drop the selection. */
  clear: () => void;
  /** Run every selected task now. Gated on free slots, since the backend leases one per
   *  run and would reject the overflow with an error toast per task. */
  runAll: BulkVerb;
  /** Make the selection sequential: each task waits on its predecessor in launch order. */
  chain: BulkVerb;
  /** Undo a chain: drop only the dependency edges INSIDE the selection. */
  unchain: BulkVerb;
  /** Delete every selected task behind one confirmation. */
  remove: BulkVerb;
  /** "Move to <column>" menu rows (the manual status move, per column). */
  moveItems: MenuItem[];
}

/** The bulk verbs (#402): act on N selected tasks once.
 *
 *  Every verb operates in the coordinator's LAUNCH order (`createdAt`, then `id` — see
 *  `selectedInLaunchOrder`), never in click order, so a bulk action can never impose a
 *  sequence the engine disagrees with. The dependency edits go through the same
 *  `onChangeDependencies` seam the DependencyEditor uses; a verb clears the selection on
 *  dispatch so the bar can't be double-fired against a stale set. */
export function useBulkActionBar({ tasks, onMoveTask }: BulkActionBarProps): BulkActionBarView {
  const { selectedIds, clear } = useTaskSelection();
  const { onRun, onChangeDependencies, onBulkDelete } = useTaskActions();
  const { freeSlots } = useRunOrder();

  const selected = useMemo(
    () => selectedInLaunchOrder(tasks, selectedIds),
    [tasks, selectedIds],
  );
  const count = selected.length;

  const runAll = useBulkRun(selected, freeSlots, onRun, clear);
  const dependencyVerbs = useDependencyVerbs(selected, onChangeDependencies, clear);
  const remove = useMemo<BulkVerb>(
    () => ({
      enabled: count > 0 && onBulkDelete !== undefined,
      reason: null,
      run: () => onBulkDelete?.(selected.map((t) => t.id)),
    }),
    [count, onBulkDelete, selected],
  );
  const moveItems = useMemo<MenuItem[]>(
    () =>
      COLUMNS.filter((col) => col.statuses[0] !== undefined)
        // In Progress / Verifying are engine-owned: `move_task` refuses a manual move
        // into them, so they are never offered (mirrors `isDroppableStatus`).
        .filter((col) => col.key !== 'in_progress' && col.key !== 'verifying')
        .map((col) => ({
          label: `Move to ${col.title}`,
          onClick: () => {
            const status = col.statuses[0] as TaskStatus;
            for (const task of selected) onMoveTask(task.id, status);
            clear();
          },
        })),
    [selected, onMoveTask, clear],
  );

  return { count, clear, runAll, ...dependencyVerbs, remove, moveItems };
}

/** The bulk Run verb: launch every selected task now. Refused when the selection exceeds
 *  the free run slots — the backend leases one slot per run and rejects the overflow, so
 *  firing anyway would produce a wall of error toasts instead of an honest gate. */
function useBulkRun(
  selected: Task[],
  freeSlots: number,
  onRun: ((id: string) => void) | undefined,
  clear: () => void,
): BulkVerb {
  const run = useCallback(() => {
    for (const task of selected) onRun?.(task.id);
    clear();
  }, [selected, onRun, clear]);
  return useMemo(() => {
    const launchable = selected.filter(
      (t) => t.status === 'backlog' || t.status === 'ready' || t.status === 'failed',
    );
    if (launchable.length !== selected.length) {
      return { enabled: false, reason: 'Some selected tasks are already running or done', run };
    }
    if (launchable.length === 0) {
      return { enabled: false, reason: 'Nothing runnable selected', run };
    }
    if (launchable.length > freeSlots) {
      return {
        enabled: false,
        reason: `Only ${freeSlots} run slot${freeSlots === 1 ? '' : 's'} free — raise concurrency or arm Auto Mode to work through the queue`,
        run,
      };
    }
    return { enabled: true, reason: null, run };
  }, [selected, freeSlots, run]);
}

/** The Chain / Unchain verbs — the pair that makes the hand-minted dependency chain a
 *  two-click operation. Both are computed from the pure edit builders, so "nothing to do"
 *  is a disabled button with a reason rather than a silent no-op dispatch. */
function useDependencyVerbs(
  selected: Task[],
  onChangeDependencies: ((id: string, dependencies: string[]) => void) | undefined,
  clear: () => void,
): { chain: BulkVerb; unchain: BulkVerb } {
  const chainPlan = useMemo(() => chainEdits(selected), [selected]);
  const unchainPlan = useMemo(() => unchainEdits(selected), [selected]);

  const apply = useCallback(
    (edits: { id: string; dependencies: string[] }[]) => {
      for (const edit of edits) onChangeDependencies?.(edit.id, edit.dependencies);
      clear();
    },
    [onChangeDependencies, clear],
  );

  const wired = onChangeDependencies !== undefined;
  return {
    chain: {
      enabled: wired && chainPlan.length > 0,
      reason:
        selected.length < 2
          ? 'Select at least two tasks to chain'
          : chainPlan.length === 0
            ? 'Already chained in this order'
            : null,
      run: () => apply(chainPlan),
    },
    unchain: {
      enabled: wired && unchainPlan.length > 0,
      reason:
        unchainPlan.length === 0
          ? 'No dependencies between the selected tasks'
          : null,
      run: () => apply(unchainPlan),
    },
  };
}
