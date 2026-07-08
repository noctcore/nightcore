import type { ProjectSwitcherSurface } from '../Sidebar/Sidebar.types';

/** Props for {@link SidebarUnified}. */
export interface SidebarUnifiedProps {
  switcher: ProjectSwitcherSurface;
  collapsed: boolean;
}

/** Presentational row for one project in the switcher dropdown. */
export interface ProjectSwitcherRowProps {
  project: import('@/lib/bridge').Project;
  onPick: () => void;
  onEdit: () => void;
}
