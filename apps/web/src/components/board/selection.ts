/** The board's multi-select seam (#402): which task cards are checked, plus the pure
 *  transforms the bulk verbs apply.
 *
 *  Selection travels by CONTEXT, keyed by task id — never as a per-row prop. That is a
 *  hard requirement, not a preference: the columns are virtualized
 *  (`@tanstack/react-virtual`), so only the visible rows are mounted at any time. An
 *  index-based or "all rows mounted" selection model would lose (or mis-assign) the
 *  selection the moment a row scrolls out. An id set survives mount/unmount, and a card
 *  reads only its own membership.
 *
 *  It also keeps drag-and-drop intact: nothing about the @dnd-kit wiring changes, and
 *  the per-card toggle lives in the action row that already stops click propagation.
 *
 *  VOLATILITY: the value changes on a click, never on a `nc:session` stream flush, and
 *  the provider memoizes it — so subscribing cards re-render on selection changes only. */
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { Task } from '@/lib/bridge';

/** The selection surface the cards and the bulk bar read. */
export interface TaskSelectionValue {
  /** Ids of the currently checked tasks. */
  selectedIds: ReadonlySet<string>;
  /** Check/uncheck one task. */
  toggle: (id: string) => void;
  /** Drop the whole selection (the bulk bar's Clear, and every bulk verb on success). */
  clear: () => void;
  /** Replace the selection with exactly these ids. */
  select: (ids: string[]) => void;
}

/** A frozen no-op selection: the fallback outside a provider, so a card rendered
 *  standalone in a story/test shows no checkbox chrome rather than crashing. */
const INERT: TaskSelectionValue = {
  selectedIds: new Set<string>(),
  toggle: () => {},
  clear: () => {},
  select: () => {},
};

/** Carries the board's selection to its cards + bulk bar. `null` = no provider above;
 *  {@link useTaskSelection} then returns the inert value. */
export const TaskSelectionContext = createContext<TaskSelectionValue | null>(null);

/** Provide the (board-memoized) selection to a subtree. A plain-`.ts` provider
 *  (feature-root module, not a component folder), so it renders via `createElement`. */
export function TaskSelectionProvider({
  value,
  children,
}: {
  value: TaskSelectionValue;
  children: ReactNode;
}) {
  return createElement(TaskSelectionContext.Provider, { value }, children);
}

/** Read the board's selection. Inert (empty, no-op) outside a provider. */
export function useTaskSelection(): TaskSelectionValue {
  return useContext(TaskSelectionContext) ?? INERT;
}

/** Own the board's selection state and expose it as a MEMOIZED context value (the board
 *  renders the provider; `context-value-must-be-memoized` forbids an inline literal, and
 *  `no-state-in-component-body` forbids the `useState` living in `Board.tsx`).
 *
 *  Self-heals against deletions: a bulk delete or a project switch removes tasks, and a
 *  lingering id would otherwise keep the bulk bar open over a phantom selection. The
 *  prune returns the same reference when nothing is stale, so the effect can't loop. */
export function useTaskSelectionState(tasks: Task[]): TaskSelectionValue {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setSelectedIds((prev) => pruneSelection(prev, tasks));
  }, [tasks]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => toggleSelection(prev, id));
  }, []);
  const clear = useCallback(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set<string>()));
  }, []);
  const select = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  return useMemo(
    () => ({ selectedIds, toggle, clear, select }),
    [selectedIds, toggle, clear, select],
  );
}

/** Toggle one id, returning a NEW set (never a mutation — the context value must be a
 *  fresh reference for consumers to re-render). Pure. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Drop ids that no longer name a live task (a selected card was deleted, or the project
 *  switched). Returns the SAME reference when nothing is stale, so the board's memo bails
 *  instead of re-rendering every card on each task event. Pure. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  tasks: Task[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const live = new Set(tasks.map((t) => t.id));
  let stale = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (live.has(id)) next.add(id);
    else stale = true;
  }
  return stale ? next : selected;
}

/** The selected tasks in the order the coordinator would launch them — `createdAt`, then
 *  `id` (the auto-loop's own tiebreak, see the Rust `eligible_tasks`). Chaining and bulk
 *  Run both use this so a bulk verb never imposes an order the engine disagrees with.
 *  Pure. */
export function selectedInLaunchOrder(
  tasks: Task[],
  selected: ReadonlySet<string>,
): Task[] {
  return tasks
    .filter((t) => selected.has(t.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** One task's next dependency list, for a bulk verb to persist. */
export interface DependencyEdit {
  id: string;
  dependencies: string[];
}

/** Build the SEQUENTIAL chain over `ordered`: each task after the first gains a
 *  dependency on its predecessor. Existing dependencies are PRESERVED — chaining adds an
 *  edge, it never silently drops one — and a link already in place yields no edit, so
 *  re-chaining the same selection is a no-op. Pure. */
export function chainEdits(ordered: Task[]): DependencyEdit[] {
  const edits: DependencyEdit[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const task = ordered[i];
    const previous = ordered[i - 1];
    if (task === undefined || previous === undefined) continue;
    if (task.dependencies.includes(previous.id)) continue;
    edits.push({ id: task.id, dependencies: [...task.dependencies, previous.id] });
  }
  return edits;
}

/** The exact inverse of {@link chainEdits}: drop every dependency edge that points at
 *  ANOTHER task in the same selection, leaving edges onto unselected tasks untouched. So
 *  "Unchain" undoes a chain without nuking dependencies the user authored elsewhere.
 *  Pure. */
export function unchainEdits(ordered: Task[]): DependencyEdit[] {
  const inSelection = new Set(ordered.map((t) => t.id));
  const edits: DependencyEdit[] = [];
  for (const task of ordered) {
    const kept = task.dependencies.filter((dep) => !inSelection.has(dep));
    if (kept.length !== task.dependencies.length) {
      edits.push({ id: task.id, dependencies: kept });
    }
  }
  return edits;
}
