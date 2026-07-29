import { useCallback, useMemo, useState } from 'react';

import { COLUMNS } from '@/components/board';
import type { Task, TaskStatus } from '@/lib/bridge';

/** A pending column-clear: the target statuses, the resolved column title, and
 *  the number of tasks the clear would delete (for the confirm copy). */
export interface PendingClear {
  statuses: TaskStatus[];
  columnTitle: string;
  count: number;
}

/** The confirmation state + triggers returned by {@link useDestructiveConfirm}. */
export interface DestructiveConfirmState {
  /** Task id awaiting a single-delete confirmation, or `null`. */
  pendingDelete: string | null;
  /** Column clear awaiting confirmation, or `null`. */
  pendingClear: PendingClear | null;
  /** Multi-select delete awaiting confirmation (#402): the selected task ids, or `null`.
   *  ONE dialog for the whole selection — N sequential dialogs is exactly the daily-driver
   *  pain the bulk verbs exist to remove. */
  pendingBulkDelete: string[] | null;
  /** Open the single-delete confirmation for a task (the card trash button). */
  requestDelete: (id: string) => void;
  /** Open the bulk-clear confirmation for a column (the column "Clear" button). */
  requestClear: (statuses: TaskStatus[]) => void;
  /** Open the multi-select delete confirmation (the bulk bar's Delete verb). A no-op for
   *  an empty selection, so the dialog can never open over nothing. */
  requestBulkDelete: (ids: string[]) => void;
  /** Run the pending destructive action and close the dialog. */
  confirm: () => void;
  /** Dismiss the dialog without acting. */
  cancel: () => void;
}

/** Resolve a column's display title from the statuses it groups (the clear is
 *  keyed by statuses; the dialog copy names the column). Falls back to a generic
 *  label if no column matches. */
function columnTitleFor(statuses: TaskStatus[]): string {
  const match = COLUMNS.find(
    (col) =>
      col.statuses.length === statuses.length &&
      col.statuses.every((s) => statuses.includes(s)),
  );
  return match?.title ?? 'this column';
}

/** Holds the confirmation state for the board's two irreversible deletes — a
 *  single card delete and a column "Clear" — so both route through a shared
 *  destructive `ConfirmDialog` instead of firing immediately. The buttons set the
 *  pending state; `confirm` runs the real (still-optimistic) action. State lives
 *  here (a hook), never in a component body. */
export function useDestructiveConfirm(
  tasks: Task[],
  onDelete: (id: string) => void,
  onClearColumn: (statuses: TaskStatus[]) => void,
): DestructiveConfirmState {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingStatuses, setPendingStatuses] = useState<TaskStatus[] | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState<string[] | null>(null);

  const requestDelete = useCallback((id: string) => setPendingDelete(id), []);
  const requestClear = useCallback((statuses: TaskStatus[]) => setPendingStatuses(statuses), []);
  const requestBulkDelete = useCallback((ids: string[]) => {
    if (ids.length > 0) setPendingBulkDelete(ids);
  }, []);

  const cancel = useCallback(() => {
    setPendingDelete(null);
    setPendingStatuses(null);
    setPendingBulkDelete(null);
  }, []);

  const confirm = useCallback(() => {
    if (pendingDelete !== null) onDelete(pendingDelete);
    if (pendingStatuses !== null) onClearColumn(pendingStatuses);
    // The bulk delete fans the SAME per-task optimistic delete the card trash uses, so a
    // partial failure rolls back per task rather than leaving the board lying wholesale.
    if (pendingBulkDelete !== null) for (const id of pendingBulkDelete) onDelete(id);
    setPendingDelete(null);
    setPendingStatuses(null);
    setPendingBulkDelete(null);
  }, [pendingDelete, pendingStatuses, pendingBulkDelete, onDelete, onClearColumn]);

  const pendingClear = useMemo<PendingClear | null>(() => {
    if (pendingStatuses === null) return null;
    const count = tasks.filter((t) => pendingStatuses.includes(t.status)).length;
    return { statuses: pendingStatuses, columnTitle: columnTitleFor(pendingStatuses), count };
  }, [pendingStatuses, tasks]);

  return {
    pendingDelete,
    pendingClear,
    pendingBulkDelete,
    requestDelete,
    requestClear,
    requestBulkDelete,
    confirm,
    cancel,
  };
}
