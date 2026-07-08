import type { ReactNode } from 'react';

import type { AppView, NavItem } from '../AppShell/AppShell.types';

/** Shared props for nav sidebar surfaces (unified + classic). */
export interface NavSidebarProps {
  view: AppView;
  nav: NavItem[];
  collapsed: boolean;
  runningCount: number;
  awaitingInputCount: number;
  version: string;
  showHeader: boolean;
  onToggleCollapsed: () => void;
  onNavigate: (view: AppView) => void;
  onGotoProjects: () => void;
  onGotoAwaitingInput: () => void;
  /** Optional header slot (unified project switcher). Hidden when `showHeader` is false. */
  header?: ReactNode;
}
