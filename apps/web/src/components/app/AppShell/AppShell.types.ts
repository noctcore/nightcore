/** The top-level surfaces the shell routes between. New Project and the
 *  Logs/TaskDetail drawer are overlays, not routes. */
export type AppView =
  | 'board'
  | 'worktrees'
  | 'insight'
  | 'scorecard'
  | 'harness'
  | 'projects'
  | 'settings';

import type { ReactNode } from 'react';

/** A nav entry in the sidebar workspace section. */
export interface NavItem {
  view: AppView;
  label: string;
  /** Single-letter keyboard hint shown as a Kbd chip. */
  hint: string;
  icon: ReactNode;
}
