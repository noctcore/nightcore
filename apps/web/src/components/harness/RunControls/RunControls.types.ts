import type { ConventionCategory } from '@/lib/bridge';

export interface RunControlsProps {
  /** The current model id override, or `null` to inherit the default. */
  model: string | null;
  /** The current reasoning-effort override, or `null` to inherit the default. */
  effort: string | null;
  /** The currently-selected lens set (membership test for the chips). */
  selected: Set<ConventionCategory>;
  /** True while the scan dispatch is in flight (Starting…). */
  isStarting: boolean;
  /** Disable the whole config (e.g. no active project). */
  disabled: boolean;
  onChangeModel: (model: string | null) => void;
  onChangeEffort: (effort: string | null) => void;
  /** Toggle one lens in/out of the selected set. */
  onToggle: (category: ConventionCategory) => void;
  /** Select every lens. */
  onSelectAll: () => void;
  /** Clear the selection. */
  onSelectNone: () => void;
  /** Launch the scan with the lifted config (≥1 lens required — gated by `canScan`). */
  onScan: () => void;
}
