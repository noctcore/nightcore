/** Prop types for the AutoModeOptions popover. */

/** Props for the Auto Mode options popover: the loop options and their setters. */
export interface AutoModeOptionsProps {
  /** Whether auto-commit-on-verified is enabled (the persisted Auto Mode option). */
  autoCommitOnVerified: boolean;
  /** Persist a change to the auto-commit-on-verified option. */
  onAutoCommitChange: (next: boolean) => void;
}
