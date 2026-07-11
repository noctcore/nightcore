/** Prop types for the AutoModeOptions popover. */

/** Props for the Auto Mode options popover: the loop options and their setters. */
export interface AutoModeOptionsProps {
  /** Whether auto-commit-on-verified is enabled (the persisted Auto Mode option). */
  autoCommitOnVerified: boolean;
  /** Persist a change to the auto-commit-on-verified option. */
  onAutoCommitChange: (next: boolean) => void;
  /** Usage-aware throttle threshold (spec 2026-07-11): the % at which Auto Mode
   *  stops picking up new runs. 50..=100, persisted. */
  autoPauseUsageThreshold: number;
  /** Persist a change to the usage-throttle threshold (clamped 50..=100). */
  onThresholdChange: (next: number) => void;
  /** Whether the usage meter is enabled — the throttle only functions when it is
   *  (decision 4), so the slider renders disabled + hinted when this is false. */
  usageMeterEnabled: boolean;
}
