import type { ProjectSwitcherSurface } from '../Sidebar/Sidebar.types';

/** Props for the classic 64px project rail. */
export interface ProjectRailProps {
  switcher: ProjectSwitcherSurface;
  runningCount: number;
  onGotoProjects: () => void;
}
