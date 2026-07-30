import { useCallback, useMemo, useState } from 'react';

import { STAGE_BY_ID, STAGE_ORDER, type StageId, type StageMeta } from '@/lib/stages';

import type { NavGroupId, NavItem } from '../AppShell/AppShell.types';

/** Metadata for one sidebar nav section.
 *  - `note` is an always-visible muted caption under the group's items — used when a
 *    stage's surface lives elsewhere (Verify's gauntlet runs per-task on the board).
 *  - `explainer` is the stage's shared lifecycle copy (`@/lib/stages`). Present on the
 *    five STAGE groups only; the header renders a toggle that reveals it, so the stage
 *    names in the chrome finally say what they mean (issue #404). */
export interface NavGroupMeta {
  label: string;
  collapsible: boolean;
  footer?: boolean;
  note?: string;
  explainer?: StageMeta;
}

/** A stage group's meta, sourced from the lifecycle table so the header label and the
 *  explainer can never disagree (and a new stage cannot ship label-only). */
function stageGroup(id: StageId, extra?: Partial<NavGroupMeta>): NavGroupMeta {
  return {
    label: STAGE_BY_ID[id].label,
    collapsible: false,
    explainer: STAGE_BY_ID[id],
    ...extra,
  };
}

export const NAV_GROUP_META: Record<NavGroupId, NavGroupMeta> = {
  project: { label: 'Project', collapsible: false },
  intake: stageGroup('intake'),
  understand: stageGroup('understand'),
  harden: stageGroup('harden'),
  enforce: stageGroup('enforce'),
  verify: stageGroup('verify', {
    note: 'Structure-Lock Gauntlet runs per-task on the board.',
  }),
  settings: { label: 'Settings', collapsible: false, footer: true },
};

/** Section order: the non-stage Project group, the five stages in LIFECYCLE order
 *  (taken from `@/lib/stages`, not re-listed here), then footer Settings. */
const GROUP_ORDER: NavGroupId[] = ['project', ...STAGE_ORDER, 'settings'];

/** One labelled nav section derived from flat {@link NavItem} rows. */
export interface NavSection extends NavGroupMeta {
  id: NavGroupId;
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

/** Collapsible-section state plus per-stage explainer disclosure for the sidebar. */
export function useNavSidebarSections(nav: NavItem[]) {
  const [collapsedSections, setCollapsedSections] = useState<Partial<Record<NavGroupId, boolean>>>(
    {},
  );
  // Which stage explainer is expanded. At most ONE at a time: the sidebar is 244px
  // wide and the explainers are prose — five open at once would push the nav off
  // screen. Re-clicking the open one closes it.
  const [explainedStage, setExplainedStage] = useState<NavGroupId | null>(null);
  const sections = useMemo(() => groupNavItems(nav), [nav]);

  const toggleSection = useCallback((id: NavGroupId) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const isSectionCollapsed = useCallback(
    (id: NavGroupId, collapsible: boolean) =>
      collapsible ? (collapsedSections[id] ?? false) : false,
    [collapsedSections],
  );

  const toggleExplainer = useCallback((id: NavGroupId) => {
    setExplainedStage((prev) => (prev === id ? null : id));
  }, []);

  return { sections, toggleSection, isSectionCollapsed, explainedStage, toggleExplainer };
}
