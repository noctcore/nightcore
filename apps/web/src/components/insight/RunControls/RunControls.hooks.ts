import { useState } from 'react';
import type { AnalysisScope, FindingCategory } from '@/lib/bridge';
import { ALL_CATEGORIES } from '../insight.constants';
import type { RunControlsProps } from './RunControls.types';

export interface RunControlsView {
  /** Whether a run is currently in flight (controls are read-only). */
  running: boolean;
  scope: AnalysisScope;
  setScope: (scope: AnalysisScope) => void;
  model: string | null;
  setModel: (model: string | null) => void;
  effort: string | null;
  setEffort: (effort: string | null) => void;
  /** The currently-selected category set (membership test for chips). */
  selected: Set<FindingCategory>;
  /** Toggle one category in/out of the selected set. */
  toggle: (category: FindingCategory) => void;
  /** Select every category. */
  selectAll: () => void;
  /** Clear the selection. */
  selectNone: () => void;
  /** The selected categories in canonical display order (sent on Analyze). */
  orderedSelected: FindingCategory[];
  /** Whether the Analyze action is currently permitted. */
  canAnalyze: boolean;
}

/** Owns the run-configuration form state: scope, model/effort overrides, and the
 *  selected category set, plus the derived ordered selection and the Analyze
 *  gate. The component shell renders purely from this view. */
export function useRunControls({
  stream,
  isStarting,
  disabled,
}: RunControlsProps): RunControlsView {
  const running = stream.status === 'running';
  const [scope, setScope] = useState<AnalysisScope>('repo');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<FindingCategory>>(
    () => new Set(ALL_CATEGORIES),
  );

  const toggle = (category: FindingCategory) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const orderedSelected = ALL_CATEGORIES.filter((c) => selected.has(c));
  const canAnalyze =
    !disabled && !running && !isStarting && orderedSelected.length > 0;

  return {
    running,
    scope,
    setScope,
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle,
    selectAll: () => setSelected(new Set(ALL_CATEGORIES)),
    selectNone: () => setSelected(new Set()),
    orderedSelected,
    canAnalyze,
  };
}
