import {
  BoardIcon,
  BranchIcon,
  BugIcon,
  GearIcon,
  GithubIcon,
  InsightIcon,
  PerfIcon,
  VerifiedIcon,
} from '@/components/ui';

import type { NavItem } from './AppShell.types';

/** Workspace sidebar nav — grouped by project / tools / settings. */
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
    // Phase-1 PR 1: temporary row in `tools`. The stage regroup (Intake →
    // Understand → Harden → Enforce → Verify) and the removal of the standalone
    // Insight/Scorecard rows land in PR 3.
    view: 'understand',
    label: 'Find & Grade',
    hint: 'U',
    icon: <InsightIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'insight',
    label: 'Insight',
    hint: 'I',
    icon: <InsightIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'scorecard',
    label: 'Scorecard',
    hint: 'R',
    icon: <PerfIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'harness',
    label: 'Harness',
    hint: 'H',
    icon: <VerifiedIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'prreview',
    label: 'PR Review',
    hint: 'P',
    icon: <GithubIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'issuetriage',
    label: 'Issue Triage',
    hint: 'T',
    icon: <BugIcon size={16} />,
    group: 'tools',
  },
  {
    view: 'settings',
    label: 'Settings',
    hint: 'S',
    icon: <GearIcon size={16} />,
    group: 'settings',
  },
];
