import type { NavItem } from '../AppShell/AppShell.types';

/** One shortcut: the key(s) to press and what they do. `context` is the terse
 *  qualifier shown after the label (for nav rows, the stage or group the
 *  destination belongs to — so the sheet also teaches the lifecycle). */
export interface ShortcutRow {
  keys: readonly string[];
  label: string;
  context?: string;
}

/** A titled block of shortcuts in the sheet. */
export interface ShortcutGroup {
  label: string;
  /** An optional caveat for the whole block (e.g. nav keys need an open project). */
  note?: string;
  rows: readonly ShortcutRow[];
}

/** Props for {@link ShortcutSheet}. */
export interface ShortcutSheetProps {
  open: boolean;
  /** The live nav rows (`APP_SHELL_NAV`). The "Go to" block is DERIVED from these,
   *  so a new destination's key appears in the sheet without being re-typed here. */
  nav: readonly NavItem[];
  onClose: () => void;
}
