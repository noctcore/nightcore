import type { ConventionCategory } from '@/lib/bridge';
import type { RunConfig } from '@/lib/useRunConfig';

export interface RunControlsProps {
  /** The lifted run config, owned by the HarnessView hook (the shared shape that
   *  Insight uses too). Carries model/effort/lens selection + the run gate. */
  config: RunConfig<ConventionCategory>;
  /** True while the scan dispatch is in flight (Starting…). */
  isStarting: boolean;
  /** Launch the scan with the current config (≥1 lens required — gated by
   *  `config.canRun`). */
  onScan: () => void;
}
