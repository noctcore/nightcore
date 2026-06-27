import type { ProposedSubtask } from '@/lib/bridge';

/** The derived view for the panel — counts that drive the header summary and the
 *  enabled/disabled state of the bulk-convert button. Pure: no state lives here. */
export interface ProposedSubtasksView {
  total: number;
  openCount: number;
  convertedCount: number;
  /** True once every proposal has been converted (the bulk button retires). */
  allConverted: boolean;
}

/** Derive the panel's view-model from the raw proposals. Module-level so the
 *  component body holds no state (folder-per-component convention). */
export function deriveProposedSubtasksView(
  subtasks: ProposedSubtask[],
): ProposedSubtasksView {
  const convertedCount = subtasks.filter((s) => s.status === 'converted').length;
  const openCount = subtasks.length - convertedCount;
  return {
    total: subtasks.length,
    openCount,
    convertedCount,
    allConverted: subtasks.length > 0 && openCount === 0,
  };
}
