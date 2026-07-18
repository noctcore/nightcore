import type { ReactNode } from 'react';

import type { Project } from '@/lib/bridge';

import type { AppView, NavItem } from '../AppShell/AppShell.types';

export type SidebarStyle = 'unified' | 'classic';

/** Project switcher callbacks + data shared by Unified and Classic layouts. */
export interface ProjectSwitcherSurface {
  projects: Project[];
  active: Project | null;
  switcherOpen: boolean;
  onToggleSwitcher: () => void;
  /** Dismiss the switcher popover (Escape / outside pointer-down). */
  onCloseSwitcher: () => void;
  onPickProject: (id: string) => void;
  onNewProject: () => void;
  onEditProject: (project: Project) => void;
  onRemoveProject: (id: string) => void;
}

/** Props for the presentational {@link Sidebar}: the project list + active
 *  project, the current view, nav items, collapse/switcher flags, and the
 *  callbacks the shell wires for navigation, project switching, and New Project. */
export interface SidebarProps {
  switcher: ProjectSwitcherSurface;
  view: AppView;
  nav: NavItem[];
  collapsed: boolean;
  sidebarStyle: SidebarStyle;
  runningCount: number;
  /** Tasks parked awaiting the user's input (permission approvals or
   *  AskUserQuestion prompts) across every view. Drives the always-visible
   *  "awaiting input" indicator so a background stall is never hidden behind a
   *  non-board surface. */
  awaitingInputCount: number;
  version: string;
  onToggleCollapsed: () => void;
  onNavigate: (view: AppView) => void;
  /** Return to the full-screen Projects view (the brand/logo is the entry point;
   *  Projects is no longer a workspace nav item). */
  onGotoProjects: () => void;
  /** Jump to the first task awaiting input: select it and open its board drawer. */
  onGotoAwaitingInput: () => void;
  /** The provider usage meter widget, rendered in the nav footer (both layouts). */
  footerSlot?: ReactNode;
  /** T11: a ready app update surfaced from the (already-running) startup probe —
   *  `version` is the available version, `onGoto` jumps to Settings → About where
   *  the idle-gated install lives. `null`/absent ⇒ up to date, no pill. */
  update?: { version: string; onGoto: () => void } | null;
}
