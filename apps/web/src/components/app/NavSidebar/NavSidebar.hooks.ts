import { useCallback, useMemo, useState } from 'react';

import type { NavGroupId, NavItem } from '../AppShell/AppShell.types';

/** Metadata for each sidebar nav section. `note` is an optional muted caption
 *  rendered under the group's items (non-interactive) — used to explain a stage
 *  whose surface lives elsewhere (Verify's gauntlet runs per-task on the board). */
export const NAV_GROUP_META: Record<
  NavGroupId,
  { label: string; collapsible: boolean; footer?: boolean; note?: string }
> = {
  project: { label: 'Project', collapsible: false },
  intake: { label: 'Intake', collapsible: false },
  understand: { label: 'Understand', collapsible: false },
  harden: { label: 'Harden', collapsible: false },
  enforce: { label: 'Enforce', collapsible: false },
  verify: {
    label: 'Verify',
    collapsible: false,
    note: 'Structure-Lock Gauntlet runs per-task on the board.',
  },
  settings: { label: 'Settings', collapsible: false, footer: true },
};

const GROUP_ORDER: NavGroupId[] = [
  'project',
  'intake',
  'understand',
  'harden',
  'enforce',
  'verify',
  'settings',
];

/** One labelled nav section derived from flat {@link NavItem} rows. */
export interface NavSection {
  id: NavGroupId;
  label: string;
  collapsible: boolean;
  footer?: boolean;
  /** Optional muted caption rendered under the section's items. */
  note?: string;
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
