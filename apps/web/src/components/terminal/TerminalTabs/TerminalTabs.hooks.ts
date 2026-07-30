/** TerminalTabs helpers: pure derivations plus the tab-strip overflow effect. The bar
 *  is otherwise stateless (data via props). */
import { type RefObject, useEffect, useRef } from 'react';

import type { WorktreeInfo } from '@/lib/bridge';

import { formatShortcut } from '../terminal-platform';
import { TERMINAL_SESSION_CAP } from '../terminal-shared';

/** Title for the new-tab button — carries the ⌘T hint (spec PR 3a) and explains the
 *  disabled state at the cap. */
export function newTabTitle(canAddTab: boolean): string {
  return canAddTab
    ? `New terminal (${formatShortcut('T')})`
    : `Terminal limit reached (${TERMINAL_SESSION_CAP}) — close a tab first`;
}

/**
 * The branch a terminal's cwd sits on, or `null` when the cwd is not a known worktree
 * (the repo root, or any folder the user browsed to). Matched by LONGEST path prefix so
 * a nested worktree wins over its parent, and only on a separator boundary so
 * `/a/feature` never matches `/a/feature-2`. Pure — the tab bar just renders it.
 *
 * #405 tab metadata: this is the branch half. PR number and listening ports are
 * deliberately NOT derived here — both need work outside the web tier (a branch→PR
 * lookup, and a per-cwd listening-port probe in Rust), and a plausible-looking guess
 * about which PR a shell belongs to is worse than an empty space.
 */
export function branchForCwd(worktrees: readonly WorktreeInfo[], cwd: string): string | null {
  let best: WorktreeInfo | null = null;
  for (const worktree of worktrees) {
    const path = worktree.path;
    const inside = cwd === path || cwd.startsWith(`${path}/`) || cwd.startsWith(`${path}\\`);
    if (!inside) continue;
    if (best === null || path.length > best.path.length) best = worktree;
  }
  return best?.branch ?? null;
}

/**
 * Keep the ACTIVE tab visible when the strip overflows (#405). With the 12-session cap
 * the strip scrolls, and ⌘1..9 / the jump-to-waiting button can select a tab that is
 * scrolled out of sight — a selection you cannot see reads as a no-op. Scrolls the
 * minimum distance (`nearest`), so it never yanks a strip that already shows the tab.
 * Returns the ref to spread on the scrolling strip.
 */
export function useActiveTabVisible(activeId: string | null): RefObject<HTMLDivElement | null> {
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeId === null) return;
    const strip = stripRef.current;
    if (strip === null) return;
    // `CSS.escape`: session ids are server-minted uuids today, but a selector built
    // from data must not become an injection point if that ever changes.
    const tab = strip.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  return stripRef;
}
