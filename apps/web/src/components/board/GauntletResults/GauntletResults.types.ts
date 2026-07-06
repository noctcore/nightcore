import type { GauntletResult, StructureLockResult } from '@/lib/bridge';

/** Props for {@link GauntletResults}. */
export interface GauntletResultsProps {
  /** The last gauntlet result, or null when it has not been run yet. */
  result: GauntletResult | null;
  /** True while a gauntlet run is in flight. */
  running: boolean;
  /** Trigger a fresh gauntlet run ("Run checks"). Named `onRunChecks` (not
   *  `onRun`) so it is not confused with the board's context-provided task-run
   *  action — the detail panel binds it to `onRunGauntlet(task.id)`. */
  onRunChecks: () => void;
  /** The Structure-Lock Gauntlet result (the project's own generated harness
   *  checks), recorded on the task by the verification gate. `null`/absent when
   *  the gate never ran or the project has no `.nightcore/harness.json`. */
  structureLock?: StructureLockResult | null;
}
