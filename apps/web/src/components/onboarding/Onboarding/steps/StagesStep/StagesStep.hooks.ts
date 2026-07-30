import { STAGES } from '@/lib/stages';

import type { StageDiagramRow } from './StagesStep.types';

/** The stage diagram's rows, derived from the shared lifecycle table (`@/lib/stages`)
 *  rather than re-typed here — the wizard, the sidebar explainers, and the nav row
 *  labels all read the same source, so they cannot drift apart. */
export function useStagesStep(): readonly StageDiagramRow[] {
  return STAGES.map((stage, index) => ({
    stage,
    number: index + 1,
    last: index === STAGES.length - 1,
  }));
}
