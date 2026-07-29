import { useCallback, useMemo, useState } from 'react';

import type { Task } from '@/lib/bridge';

import { useTaskActions } from '../actions';
import type { DependencyEditorProps } from './DependencyEditor.types';
import type { DependencyCandidate, DependencyRow } from './DependencyEditor.utils';
import { dependencyCandidates, dependencyRows } from './DependencyEditor.utils';

/** The editor's view: the resolved current rows, the filtered candidate list, the picker
 *  disclosure + query, and the add/remove commits. */
export interface DependencyEditorView {
  /** The task's declared dependencies, resolved to title + satisfied. */
  rows: DependencyRow[];
  /** Addable (or reason-disabled) candidates for the picker, launch-ordered. */
  candidates: DependencyCandidate[];
  /** Whether the picker is open. */
  picking: boolean;
  /** Open/close the picker (closing clears the query). */
  togglePicking: () => void;
  /** The picker's keyword filter. */
  query: string;
  setQuery: (value: string) => void;
  /** Add a dependency (appends the id, then closes the picker). */
  add: (id: string) => void;
  /** Remove one declared dependency id. */
  remove: (id: string) => void;
  /** True when the commit handler is wired (the drawer degrades to read-only without it). */
  canEdit: boolean;
}

/** Drive the dependency editor (#402). The commit path is `onChangeDependencies` from
 *  `TaskActionsContext` → `update_task { dependencies }` → the `nc:task` echo; nothing is
 *  patched locally, because dependency satisfaction and run order are recomputed
 *  BACKEND-side (`blocked_task_ids` / `run_order`) and a local guess would contradict them.
 *
 *  Every list transform is a pure helper in the colocated `.utils` (including the cycle
 *  guard), so this hook only owns the picker disclosure + query. */
export function useDependencyEditor({
  task,
  tasks,
  editable = true,
}: DependencyEditorProps): DependencyEditorView {
  const { onChangeDependencies } = useTaskActions();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const rows = useMemo(() => dependencyRows(task, byId), [task, byId]);
  const candidates = useMemo(
    () => dependencyCandidates(task, tasks, query),
    [task, tasks, query],
  );

  const canEdit = editable && onChangeDependencies !== undefined;

  const commit = useCallback(
    (next: string[]) => onChangeDependencies?.(task.id, next),
    [onChangeDependencies, task.id],
  );

  const togglePicking = useCallback(() => {
    setPicking((open) => {
      if (open) setQuery('');
      return !open;
    });
  }, []);

  const add = useCallback(
    (id: string) => {
      if (task.dependencies.includes(id)) return;
      commit([...task.dependencies, id]);
      setPicking(false);
      setQuery('');
    },
    [commit, task.dependencies],
  );

  const remove = useCallback(
    (id: string) => commit(task.dependencies.filter((dep) => dep !== id)),
    [commit, task.dependencies],
  );

  return {
    rows,
    candidates,
    picking,
    togglePicking,
    query,
    setQuery,
    add,
    remove,
    canEdit,
  };
}

/** A short, stable label for a task in the editor's lists. Pure. */
export function candidateLabel(candidate: Task): string {
  return candidate.title.trim() === '' ? 'Untitled task' : candidate.title;
}
