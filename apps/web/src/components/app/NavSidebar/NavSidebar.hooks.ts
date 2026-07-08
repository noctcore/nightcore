import { useCallback, useMemo, useState } from 'react';

import type { NavGroupId, NavItem } from '../AppShell/AppShell.types';

/** Metadata for each sidebar nav section. */
export const NAV_GROUP_META: Record<
  NavGroupId,
  { label: string; collapsible: boolean; footer?: boolean }
> = {
  project: { label: 'Project', collapsible: false },
  tools: { label: 'Tools', collapsible: true },
  settings: { label: 'Settings', collapsible: false, footer: true },
};

const GROUP_ORDER: NavGroupId[] = ['project', 'tools', 'settings'];

/** One labelled nav section derived from flat {@link NavItem} rows. */
export interface NavSection {
  id: NavGroupId;
  label: string;
  collapsible: boolean;
  footer?: boolean;
  items: NavItem[];
}

/** Bucket flat nav rows into ordered sections, dropping empty groups. */
export function groupNavItems(nav: NavItem[]): NavSection[] {
  const buckets = new Map<NavGroupId, NavItem[]>();
  for (const id of GROUP_ORDER) buckets.set(id, []);
  for (const item of nav) {
    buckets.get(item.group)?.push(item);
  }
  return GROUP_ORDER.flatMap((id) => {
    const items = buckets.get(id) ?? [];
    if (items.length === 0) return [];
    return [{ id, ...NAV_GROUP_META[id], items }];
  });
}

/** Collapsible section state for grouped sidebar navigation. */
export function useNavSidebarSections(nav: NavItem[]) {
  const [collapsedSections, setCollapsedSections] = useState<Partial<Record<NavGroupId, boolean>>>(
    {},
  );
  const sections = useMemo(() => groupNavItems(nav), [nav]);

  const toggleSection = useCallback((id: NavGroupId) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const isSectionCollapsed = useCallback(
    (id: NavGroupId, collapsible: boolean) =>
      collapsible ? (collapsedSections[id] ?? false) : false,
    [collapsedSections],
  );

  return { sections, toggleSection, isSectionCollapsed };
}
