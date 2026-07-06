/**
 * The shared worktrees context: the active project's live worktrees, the
 * selected worktree tab, and the shell-owned select / remove / refresh handlers.
 *
 * It lives in `lib/` because two features consume it — the board's
 * `WorktreeSwitcher` (tab bar + board filter) and the worktree feature's
 * standalone `WorktreeView` — and `no-cross-feature-imports` forbids a
 * feature-to-feature import; `lib/` is the sanctioned shared home (the
 * `useScanRun` precedent). The provider value is assembled and memoized by the
 * shell (`useAppShell`), which owns the underlying `useWorktrees` hook.
 *
 * VOLATILITY: `worktrees` refetches on a debounced `nc:task` (never on a
 * per-frame `nc:session` flush) and the selection changes only on user clicks /
 * project switches, so the value is safe to share through context without
 * defeating the board's memo economy. Stream-flush-volatile values must NEVER
 * enter this context.
 */
import { createContext, createElement, type ReactNode, useContext } from 'react';

import type { WorktreeInfo } from '@/lib/bridge';

/** The active worktree selection: a branch name, or `null` for the Main tab. */
export type ActiveWorktree = string | null;

/** The slice of a worktree tab the remove flow needs — structurally satisfied by
 *  the board's richer `WorktreeTab`. */
export interface RemovableWorktreeTab {
  /** The worktree's branch (`null` = the Main tab, which is never removable). */
  branch: string | null;
  /** The task ids grouped under the tab — the discard targets. */
  taskIds: string[];
}

/** Everything the worktree surfaces share: the live list, the selection, and the
 *  shell-owned handlers. */
export interface WorktreesContextValue {
  /** The active project's live worktrees (from `listWorktrees`). */
  worktrees: WorktreeInfo[];
  /** The selected worktree tab (`null` = Main); filters the board. */
  activeWorktree: ActiveWorktree;
  /** Select a worktree tab (sets the active worktree + filters the board). */
  setActiveWorktree: (active: ActiveWorktree) => void;
  /** Remove a worktree tab: discard its task's checkout + branch (running-guarded
   *  backend); the `nc:task` echo drops the tab. */
  removeWorktree: (tab: RemovableWorktreeTab) => void;
  /** Explicit "Refresh": reconcile worktrees server-side (prune orphans, clear
   *  ghost pointers, reclaim merged) AND re-pull tasks. */
  refreshWorktrees: () => void;
}

/** Carries the shell's worktree state to the board switcher, the board's
 *  worktree filter, and the standalone WorktreeView. `null` = no provider. */
export const WorktreesContext = createContext<WorktreesContextValue | null>(null);

/** Provide the shell's (memoized) worktrees value to a subtree. A plain-`.ts`
 *  provider (shared lib module, not a component folder), so it renders via
 *  `createElement` rather than JSX. */
export function WorktreesProvider({
  value,
  children,
}: {
  value: WorktreesContextValue;
  children: ReactNode;
}) {
  return createElement(WorktreesContext.Provider, { value }, children);
}

/** Read the shared worktrees state. Throws outside a provider so a missing
 *  wiring fails loudly in dev/test instead of rendering an empty switcher. */
export function useWorktreesContext(): WorktreesContextValue {
  const value = useContext(WorktreesContext);
  if (value === null) {
    throw new Error('useWorktreesContext must be used within a <WorktreesProvider>.');
  }
  return value;
}
