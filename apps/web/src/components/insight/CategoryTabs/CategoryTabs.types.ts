import type { FindingCategory } from '@/lib/bridge';

/** One tab descriptor: the "All" pseudo-category or a real category, with its open
 *  finding count and whether its pass is still running. */
export interface CategoryTab {
  key: 'all' | FindingCategory;
  count: number;
  running: boolean;
  errored: boolean;
}

export interface CategoryTabsProps {
  tabs: CategoryTab[];
  active: 'all' | FindingCategory;
  onSelect: (key: 'all' | FindingCategory) => void;
}
