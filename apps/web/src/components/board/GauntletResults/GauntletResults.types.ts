import type { GauntletResult, StructureLockResult } from '@/lib/bridge';

export interface GauntletResultsProps {
  /** The last gauntlet result, or null when it has not been run yet. */
  result: GauntletResult | null;
  /** True while a gauntlet run is in flight. */
  running: boolean;
  /** Trigger a fresh gauntlet run ("Run checks"). */
  onRun: () => void;
  /** Feature #3: the Structure-Lock Gauntlet result (the project's own generated
   *  harness checks), recorded on the task by the verification gate. `null`/absent
   *  when the gate never ran or the project has no `.nightcore/harness.json`. */
  structureLock?: StructureLockResult | null;
}
