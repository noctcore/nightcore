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
import { STAGE_BY_ID } from '@/lib/stages';

import type { NavItem } from './AppShell.types';

/** Workspace sidebar nav — grouped by the five workflow stages (Intake →
 *  Understand → Harden → Enforce → Verify) plus the non-stage Project and footer
 *  Settings groups. Each stage is its own mono-uppercase group header (kept even
 *  for single-child groups); the group metadata + order live in
 *  `NavSidebar.hooks.ts` (NAV_GROUP_META / GROUP_ORDER). Hints K W L R C T U H E P S
 *  are all distinct (L = the Terminal view, R = the History view — freed with I by
 *  removing the standalone Insight / Scorecard rows in the PR 3 stage flip; C = the
 *  Council canvas).
 *
 *  Each STAGE row takes its label from the shared lifecycle table's `destination`
 *  (`@/lib/stages`, issue #404) — the same field the onboarding stage diagram and the
 *  sidebar explainers print, so the nav row and the explanation of it are one string,
 *  not two that drift. Non-stage rows (Project group, Settings) name themselves. */
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
    label: STAGE_BY_ID.intake.destination,
    hint: 'T',
    icon: <BugIcon size={16} />,
    group: 'intake',
  },
  {
    view: 'understand',
    label: STAGE_BY_ID.understand.destination,
    hint: 'U',
    icon: <InsightIcon size={16} />,
    group: 'understand',
  },
  {
    view: 'harden',
    label: STAGE_BY_ID.harden.destination,
    hint: 'H',
    icon: <RefineIcon size={16} />,
    group: 'harden',
  },
  {
    view: 'enforce',
    label: STAGE_BY_ID.enforce.destination,
    hint: 'E',
    icon: <LockIcon size={16} />,
    group: 'enforce',
  },
  {
    view: 'prreview',
    label: STAGE_BY_ID.verify.destination,
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
