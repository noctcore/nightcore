import type { Project } from '@/lib/bridge';

import type { AppView, NavItem } from '../AppShell/AppShell.types';

/** Props for the presentational {@link Sidebar}: the project list + active
 *  project, the current view, nav items, collapse/switcher flags, and the
 *  callbacks the shell wires for navigation, project switching, and New Project. */
export interface SidebarProps {
  projects: Project[];
  active: Project | null;
  view: AppView;
  nav: NavItem[];
  collapsed: boolean;
  switcherOpen: boolean;
  runningCount: number;
  /** Tasks parked awaiting the user's input (permission approvals or
   *  AskUserQuestion prompts) across every view. Drives the always-visible
   *  "awaiting input" indicator so a background stall is never hidden behind a
   *  non-board surface. */
  awaitingInputCount: number;
  version: string;
  onToggleCollapsed: () => void;
  onToggleSwitcher: () => void;
  onNavigate: (view: AppView) => void;
  /** Return to the full-screen Projects view (the brand/logo is the entry point;
   *  Projects is no longer a workspace nav item). */
  onGotoProjects: () => void;
  onPickProject: (id: string) => void;
  onNewProject: () => void;
  /** Jump to the first task awaiting input: select it and open its board drawer. */
  onGotoAwaitingInput: () => void;
}
