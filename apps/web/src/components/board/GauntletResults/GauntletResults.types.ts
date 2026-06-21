import type { GauntletResult } from '@/lib/bridge';

export interface GauntletResultsProps {
  /** The last gauntlet result, or null when it has not been run yet. */
  result: GauntletResult | null;
  /** True while a gauntlet run is in flight. */
  running: boolean;
  /** Trigger a fresh gauntlet run ("Run checks"). */
  onRun: () => void;
}
