/** The convention-lens tab strip for the Harness results view — a thin wrapper
 *  that feeds Harness's lens metadata into the shared {@link CategoryTabsShell}. */
import { CategoryTabsShell } from '@/components/ui';

import { CATEGORY_META } from '../harness.constants';
import type { CategoryTabsProps } from './CategoryTabs.types';

/** Resolves each lens's label + glyph from `CATEGORY_META` (with the "All"
 *  pseudo-lens) and renders the shared tab strip. */
export function CategoryTabs({ tabs, active, onSelect }: CategoryTabsProps) {
  return (
    <CategoryTabsShell
      tabs={tabs.map((tab) => ({
        ...tab,
        label: tab.key === 'all' ? 'All' : CATEGORY_META[tab.key].label,
        icon: tab.key === 'all' ? null : CATEGORY_META[tab.key].icon,
      }))}
      active={active}
      onSelect={onSelect}
      listLabel="Convention lenses"
      errorLabel="scan failed"
    />
  );
}
