/** Shared run-configuration form state (model/effort + category lens set) for the
 *  Insight and Harness views. */
import { useMemo, useState } from 'react';

/** Values used to pre-fill the form on "New run" (from the last/loaded run). */
export interface RunConfigPrefill<C extends string> {
  model?: string | null;
  categories?: C[];
}

/**
 * The lifted run-configuration form state shared by the Insight and Harness
 * views — model/effort overrides plus the selected category (lens) set, with the
 * derived ordered selection and the run gate. It lives ABOVE the RunControls form
 * (instantiated by each view's hook) so the config survives the
 * CONFIGURE → RUNNING → RESULTS phase swaps and pre-fills on a new run.
 *
 * Generic over the category union `C` so each view supplies its own lens
 * vocabulary. Insight wraps this to add its repo/diff `scope`; Harness uses it
 * as-is. Living in `lib/` keeps it out of either feature folder (the
 * `no-cross-feature-imports` lint rule forbids insight↔harness sharing).
 */
export interface RunConfig<C extends string> {
  model: string | null;
  setModel: (model: string | null) => void;
  effort: string | null;
  setEffort: (effort: string | null) => void;
  /** The currently-selected category set (membership test for the chips). */
  selected: Set<C>;
  /** Toggle one category in/out of the selected set. */
  toggle: (category: C) => void;
  /** Select every category. */
  selectAll: () => void;
  /** Clear the selection. */
  selectNone: () => void;
  /** Pre-fill the form from a prior run (used by "New run" / "Retry"). */
  prefill: (opts: RunConfigPrefill<C>) => void;
  /** The selected categories in canonical (`allCategories`) display order. */
  orderedSelected: C[];
  /** Whether the run action is currently permitted (≥1 category, not disabled). */
  canRun: boolean;
}

/**
 * Own the shared run-config form state.
 *
 * @param allCategories the full, canonically-ordered lens vocabulary (a stable
 *   module constant — used for the initial selection, ordering, and select-all).
 * @param disabled when true (e.g. no active project), `canRun` is never permitted.
 */
export function useRunConfig<C extends string>(
  allCategories: readonly C[],
  disabled: boolean,
): RunConfig<C> {
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<C>>(() => new Set(allCategories));

  const orderedSelected = useMemo(
    () => allCategories.filter((c) => selected.has(c)),
    [allCategories, selected],
  );
  const canRun = !disabled && orderedSelected.length > 0;

  return {
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle: (category) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(category)) next.delete(category);
        else next.add(category);
        return next;
      }),
    selectAll: () => setSelected(new Set(allCategories)),
    selectNone: () => setSelected(new Set()),
    prefill: ({ model: nextModel, categories }) => {
      if (nextModel !== undefined) setModel(nextModel);
      if (categories !== undefined && categories.length > 0) {
        setSelected(new Set(categories));
      }
    },
    orderedSelected,
    canRun,
  };
}
