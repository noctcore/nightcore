/** The top-level surfaces the shell routes between. New Project and the
 *  Logs/TaskDetail drawer are overlays, not routes. */
export type AppView =
  | 'board'
  | 'worktrees'
  // The five stage destinations (Phase-1 view rethink, PR 3): Understand hosts
  // Insight's Find + Scorecard's Grade behind one shell; Harden / Enforce are two
  // view filters over the ONE HarnessView run/store; PR Review + Issue Triage keep
  // their own destinations. The standalone `insight` / `scorecard` / `harness`
  // routes were removed in PR 3 — every stale literal is now a compile error, and
  // the source-ref REGISTRY retargets legacy provenance tokens onto these keys.
  | 'understand'
  | 'harden'
  | 'enforce'
  | 'prreview'
  | 'issuetriage'
  | 'projects'
  | 'settings';

import type { ReactNode } from 'react';

/** Sidebar nav section ids — the five workflow stages (Intake → Understand →
 *  Harden → Enforce → Verify) framed by the non-stage Project group and the
 *  footer-placed Settings group. */
export type NavGroupId =
  | 'project'
  | 'intake'
  | 'understand'
  | 'harden'
  | 'enforce'
  | 'verify'
  | 'settings';

/** A nav entry in the sidebar workspace section. */
export interface NavItem {
  view: AppView;
  label: string;
  /** Single-letter keyboard hint shown as a Kbd chip. */
  hint: string;
  icon: ReactNode;
  group: NavGroupId;
}
