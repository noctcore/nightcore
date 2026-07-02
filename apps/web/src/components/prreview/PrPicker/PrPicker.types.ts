/** Types for the PR Review pull-request picker. */
import type { PrSummary } from '@/lib/bridge';

/** Props for the presentational {@link PrPicker}. The parent (RunControls) owns the
 *  open-PR fetch (via `useOpenPrs`) and the chosen value (via the run-config), so the
 *  picker itself is a controlled, list-in / selection-out view — testable with plain
 *  props, exactly like `BranchPicker`. */
export interface PrPickerProps {
  /** The active project's open pull requests, newest first. */
  prs: PrSummary[];
  /** True while the list is being (re)fetched. */
  loading: boolean;
  /** A fetch error to surface inline (gh not installed / no remote / auth), or null. */
  error: string | null;
  /** The currently chosen PR number, or null when none is selected. */
  value: number | null;
  /** Choose a PR (from the list or a typed number), or clear with null. */
  onChange: (prNumber: number | null) => void;
  /** Re-fetch the open-PR list. */
  onRefresh: () => void;
  /** Disable all interaction (e.g. while a run is starting). */
  disabled?: boolean;
}

/** One rendered PR row (a summary plus whether it is the chosen one). */
export interface PrPickerRow {
  pr: PrSummary;
  selected: boolean;
}
