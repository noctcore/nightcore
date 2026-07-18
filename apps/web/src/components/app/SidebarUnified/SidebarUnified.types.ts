import type { ProjectSwitcherSurface } from '../Sidebar/Sidebar.types';

/** Props for {@link SidebarUnified}. */
export interface SidebarUnifiedProps {
  switcher: ProjectSwitcherSurface;
  collapsed: boolean;
}

/** Presentational row for one project in the switcher dropdown. */
export interface ProjectSwitcherRowProps {
  project: import('@/lib/bridge').Project;
  /** Marks the currently-active project — tints the row + sets `aria-current`. */
  active: boolean;
  onPick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}
