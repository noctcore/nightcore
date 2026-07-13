import {
  AgentsIcon,
  BoardIcon,
  BranchIcon,
  BugIcon,
  GearIcon,
  GithubIcon,
  HistoryIcon,
  InsightIcon,
  LockIcon,
  RefineIcon,
  TerminalIcon,
} from '@/components/ui';

import type { NavItem } from './AppShell.types';

/** Workspace sidebar nav — grouped by the five workflow stages (Intake →
 *  Understand → Harden → Enforce → Verify) plus the non-stage Project and footer
 *  Settings groups. Each stage is its own mono-uppercase group header (kept even
 *  for single-child groups); the group metadata + order live in
 *  `NavSidebar.hooks.ts` (NAV_GROUP_META / GROUP_ORDER). Hints K W L R C T U H E P S
 *  are all distinct (L = the Terminal view, R = the History view — freed with I by
 *  removing the standalone Insight / Scorecard rows in the PR 3 stage flip; C = the
 *  Council canvas). */
export const APP_SHELL_NAV: NavItem[] = [
  {
    view: 'board',
    label: 'Kanban Board',
    hint: 'K',
    icon: <BoardIcon size={16} />,
    group: 'project',
  },
  {
    view: 'worktrees',
    label: 'Worktrees',
    hint: 'W',
    icon: <BranchIcon size={16} />,
    group: 'project',
  },
  {
    view: 'terminal',
    label: 'Terminal',
    hint: 'L',
    icon: <TerminalIcon size={16} />,
    group: 'project',
  },
  {
    view: 'history',
    label: 'History',
    hint: 'R',
    icon: <HistoryIcon size={16} />,
    group: 'project',
  },
  {
    view: 'council',
    label: 'Council',
    hint: 'C',
    icon: <AgentsIcon size={16} />,
    group: 'project',
  },
  {
    view: 'issuetriage',
    label: 'Issue Triage',
    hint: 'T',
    icon: <BugIcon size={16} />,
    group: 'intake',
  },
  {
    view: 'understand',
    label: 'Find & Grade',
    hint: 'U',
    icon: <InsightIcon size={16} />,
    group: 'understand',
  },
  {
    view: 'harden',
    label: 'Propose',
    hint: 'H',
    icon: <RefineIcon size={16} />,
    group: 'harden',
  },
  {
    view: 'enforce',
    label: 'Conventions',
    hint: 'E',
    icon: <LockIcon size={16} />,
    group: 'enforce',
  },
  {
    view: 'prreview',
    label: 'PR Review',
    hint: 'P',
    icon: <GithubIcon size={16} />,
    group: 'verify',
  },
  {
    view: 'settings',
    label: 'Settings',
    hint: 'S',
    icon: <GearIcon size={16} />,
    group: 'settings',
  },
];
