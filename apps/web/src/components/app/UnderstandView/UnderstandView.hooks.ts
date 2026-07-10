import { useCallback, useEffect, useState } from 'react';

import type { ScanTarget } from '@/lib/source-ref';

import type { UnderstandMode, UnderstandViewProps } from './UnderstandView.types';

/** Which sub-view owns a given provenance target. The `ScanTarget.family`
 *  discriminator (added in PR 3) says which tool minted it — a Scorecard
 *  (`family: 'scorecard'`) target lands on Grade, an Insight (`family: 'insight'`)
 *  target on Find. Returns `null` for an absent target. */
function modeForTarget(target: ScanTarget | null | undefined): UnderstandMode | null {
  if (target === null || target === undefined) return null;
  return target.family === 'scorecard' ? 'grade' : 'find';
}

/** State model for the Understand shell: owns the Find|Grade toggle and routes a
 *  provenance preselect to the sub-view that owns it (the other gets `null` so it
 *  never tries to consume a target that isn't its own). The shell never touches
 *  run state — each inner view keeps its own `useScanRun`, engine, and store. */
export function useUnderstandView({ preselect }: UnderstandViewProps): {
  mode: UnderstandMode;
  selectMode: (value: string) => void;
  findPreselect: ScanTarget | null;
  gradePreselect: ScanTarget | null;
} {
  // Initialize on the sub-view that owns any arriving preselect, else Find.
  const [mode, setMode] = useState<UnderstandMode>(() => modeForTarget(preselect) ?? 'find');

  // A provenance target arriving later (a chip clicked while the shell is
  // already mounted) flips the toggle so the finding/reading lands on-screen.
  useEffect(() => {
    const target = modeForTarget(preselect);
    if (target !== null) setMode(target);
  }, [preselect]);

  // The Segmented control emits the raw string value; narrow it to the mode
  // union here so the shell body stays a thin, cast-free shell.
  const selectMode = useCallback((value: string): void => {
    if (value === 'find' || value === 'grade') setMode(value);
  }, []);

  // Hand each sub-view ONLY the target it owns (gated by `family`), so the other
  // never tries to consume a preselect that isn't its own.
  return {
    mode,
    selectMode,
    findPreselect: preselect?.family === 'insight' ? preselect : null,
    gradePreselect: preselect?.family === 'scorecard' ? preselect : null,
  };
}
