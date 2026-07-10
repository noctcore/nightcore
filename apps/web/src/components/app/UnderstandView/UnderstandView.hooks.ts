import { useCallback, useEffect, useState } from 'react';

import type { ScanTarget } from '@/lib/source-ref';

import type { UnderstandMode, UnderstandViewProps } from './UnderstandView.types';

/** Which sub-view owns a given provenance target. Phase-1 PR 1: the `ScanTarget`
 *  carries no `family` discriminator yet (added in PR 3), so we route by `kind` —
 *  a Scorecard `reading` lands on Grade, an Insight `finding` on Find. When
 *  PR 3 adds `family`, this narrows to `family === 'scorecard'` with no other
 *  change to the shell. Returns `null` for an absent target. */
function modeForTarget(target: ScanTarget | null | undefined): UnderstandMode | null {
  if (target === null || target === undefined) return null;
  return target.kind === 'reading' ? 'grade' : 'find';
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

  const targetMode = modeForTarget(preselect);
  return {
    mode,
    selectMode,
    findPreselect: targetMode === 'find' ? (preselect ?? null) : null,
    gradePreselect: targetMode === 'grade' ? (preselect ?? null) : null,
  };
}
