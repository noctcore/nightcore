/** Props + view types for the BranchPicker combobox. */
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';
import type { BranchInfo } from '@/lib/bridge';

/** Props for the BranchPicker — a presentational branch combobox. The current
 *  branch name is fully controlled; the parent owns the branch list and persists
 *  the chosen value (branch creation, if any, happens server-side). */
export interface BranchPickerProps {
  /** The current branch name (controlled). Doubles as the filter query. */
  value: string;
  /** Fired on every keystroke and when a branch (or the create row) is picked. */
  onChange: (value: string) => void;
  /** The branches available to choose from. */
  branches: BranchInfo[];
  /** When the typed text matches no branch, offer a "Create "<text>"" row.
   *  Defaults to `true`. */
  allowCreate?: boolean;
  /** Placeholder for the empty input. */
  placeholder?: string;
  /** Disable the whole control (input + dropdown). */
  disabled?: boolean;
  /** Accessible name for the input (and the listbox). */
  ariaLabel?: string;
}

/** A single selectable branch row, pre-assigned its flat keyboard-nav index and a
 *  stable option id (so the input's `aria-activedescendant` can point at it). */
export interface BranchRow {
  branch: BranchInfo;
  /** Position in the flat selectable list (local → remote → create). */
  index: number;
  /** DOM id for the `role="option"` element. */
  id: string;
}

/** The synthetic "Create "<text>"" row, when {@link BranchPickerProps.allowCreate}
 *  is on and the typed text matches no branch exactly. */
export interface CreateRow {
  value: string;
  index: number;
  id: string;
}

/** Everything the thin BranchPicker shell renders — open/filter/highlight state
 *  plus the input handlers, computed by {@link useBranchPicker}. */
export interface BranchPickerView {
  /** Whether the dropdown is open (always false while disabled). */
  open: boolean;
  /** Filtered local branches, in display order. */
  localRows: BranchRow[];
  /** Filtered remote-tracking branches, in display order. */
  remoteRows: BranchRow[];
  /** The create affordance, or null when not applicable. */
  createRow: CreateRow | null;
  /** Whether any branch matched the filter (drives the empty-state row). */
  hasMatches: boolean;
  /** The flat index currently highlighted (-1 when there is nothing to pick). */
  highlight: number;
  /** id of the listbox element (referenced by the input's `aria-controls`). */
  listboxId: string;
  /** id of the highlighted option (the input's `aria-activedescendant`). */
  activeOptionId: string | undefined;
  /** Mirror typed text up and keep the menu open. */
  onInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Open the menu when the input gains focus. */
  onInputFocus: () => void;
  /** Arrow up/down to move the highlight, Enter to pick, Esc to close. */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Close the menu when focus leaves the whole control. */
  onContainerBlur: (e: FocusEvent<HTMLDivElement>) => void;
  /** Move the highlight to a row under the pointer. */
  onHighlight: (index: number) => void;
  /** Pick a branch by name (fires onChange, closes the menu). */
  selectBranch: (name: string) => void;
  /** Keep the typed text as a to-be-created branch (fires onChange, closes). */
  selectCreate: () => void;
}
