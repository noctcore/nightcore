/** Types for the shared CategoryTabsShell tab strip. */
import type { ComponentType } from 'react';

/** One resolved tab descriptor: its key, the display label and glyph (null for an
 *  "All" pseudo-tab), the open-finding count, and the running/errored flags. */
export interface CategoryTabDescriptor<K extends string = string> {
  key: K;
  label: string;
  icon: ComponentType<{ size?: number }> | null;
  count: number;
  running: boolean;
  errored: boolean;
}

/** Props for {@link CategoryTabsShell}: the resolved tab descriptors, the active
 *  key, a select handler, and the two feature-specific accessible labels. */
export interface CategoryTabsShellProps<K extends string = string> {
  tabs: CategoryTabDescriptor<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** Accessible name for the `role="tablist"` strip (e.g. "Finding categories"). */
  listLabel: string;
  /** Accessible label for a tab's error indicator (e.g. "analysis failed"). */
  errorLabel: string;
}
