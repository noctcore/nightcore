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
  /** Optional layout slots: the unified project-switcher `header` (hidden when
   *  `showHeader` is false) and a `footer` rendered above the version/GitHub row
   *  (the provider usage meter widget) in both layouts. Grouped into one object so
   *  the nav's prop contract stays within the max-props budget. */
  slots?: { header?: ReactNode; footer?: ReactNode };
}
