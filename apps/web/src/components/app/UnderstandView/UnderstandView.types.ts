import type { ScanTarget } from '@/lib/source-ref';

/** The two lenses the Understand shell toggles between: Find = Insight's
 *  find→fix view-model, Grade = the Readiness Scorecard's grade→harden one. */
export type UnderstandMode = 'find' | 'grade';

/** Props for the Understand shell. Mirrors the shared 5-prop scan-view contract
 *  (`projectPath` / `projectName` / `onGotoBoard` / `preselect` /
 *  `onPreselectConsumed`) so the shell forwards it straight through to whichever
 *  inner view (`InsightView` / `ScorecardView`) is mounted. */
export interface UnderstandViewProps {
  /** The active project's absolute path (null when no project is active). */
  projectPath: string | null;
  /** The active project's display name. */
  projectName: string | null;
  /** Navigate to the board (used after convert-to-task / harden-this). */
  onGotoBoard?: () => void;
  /** A board→scan provenance target: the run + item to load and open on mount.
   *  The shell flips to the sub-view that owns it and hands it down. */
  preselect?: ScanTarget | null;
  /** Acknowledge the preselect so routing clears it (it never refires). */
  onPreselectConsumed?: () => void;
}
