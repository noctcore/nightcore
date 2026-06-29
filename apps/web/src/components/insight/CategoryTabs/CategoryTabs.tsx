/** The category tab strip for the Insight results view — a thin wrapper that
 *  feeds Insight's category metadata into the shared {@link CategoryTabsShell}. */
import { CategoryTabsShell } from '@/components/ui';
import { CATEGORY_META } from '../insight.constants';
import type { CategoryTabsProps } from './CategoryTabs.types';

/** Resolves each tab's label + glyph from `CATEGORY_META` (with the "All"
 *  pseudo-category) and renders the shared tab strip. */
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
      listLabel="Finding categories"
      errorLabel="analysis failed"
    />
  );
}
