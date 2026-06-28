/** Types for the CategoryTabs convention-lens tab strip. */
import type { ConventionCategory } from '@/lib/bridge';

/** One tab descriptor: the "All" pseudo-lens or a real convention lens, with its
 *  open finding count and whether its pass is still running. */
export interface CategoryTab {
  key: 'all' | ConventionCategory;
  count: number;
  running: boolean;
  errored: boolean;
}

/** Props for {@link CategoryTabs}: the tab descriptors, the active key, and the select callback. */
export interface CategoryTabsProps {
  tabs: CategoryTab[];
  active: 'all' | ConventionCategory;
  onSelect: (key: 'all' | ConventionCategory) => void;
}
