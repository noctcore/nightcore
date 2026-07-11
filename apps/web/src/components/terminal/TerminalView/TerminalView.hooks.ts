/** Orchestration for the global Terminal view: the tab/session list, the restore-
 *  on-relaunch read-only tabs (decision 3), the new-tab picker + spawn with the
 *  macOS confined toggle (decision 1) and the GPU-renderer choice (decision 7), and
 *  the confirm-gated tab close. The view component is a thin shell over this. Live
 *  xterm instances are owned by the feature's session manager (kept alive across the
 *  shell's routed-view remounts); this hook owns only the React-facing state. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  deleteTerminalPersisted,
  directoryExists,
  getAppInfo,
  listTerminals,
  listTerminalsPersisted,
  type PersistedTerminalInfo,
  setTerminalTitle,
  type TerminalSessionInfo,
} from '@/lib/bridge';

import type { TerminalTarget } from '../NewTabPicker';
import { useTerminalLayout } from '../terminal-layout';
import {
  closeSession,
  getUnread,
  hasSession,
  openSession,
  reconcileSessions,
  subscribeActivity,
} from '../terminal-session-manager';
import {
  atSessionCap,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  displayPath,
  supportsConfinedTerminal,
} from '../terminal-shared';
import type { UseTerminalViewInput } from './TerminalView.types';

/** A Rust command rejection arrives as a string; normalize any thrown value to a
 *  user-facing line for the picker's inline error. */
function spawnErrorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return 'Could not open the terminal.';
}

/** Build the picker's target list: the repo root first, then each live worktree. */
function buildTargets(input: UseTerminalViewInput): TerminalTarget[] {
  const targets: TerminalTarget[] = [];
  if (input.projectPath !== null) {
    targets.push({
      kind: 'repo',
      label: input.projectName ?? 'Repo root',
      // `path` stays canonical — it is the spawn cwd (re-canonicalized server-side)
      // and the fresh-shell restore-membership key. Only `detail` is prettified for
      // display, so a Windows verbatim path (`\\?\X:\dev\nightcore`) shows cleanly.
      path: input.projectPath,
      detail: displayPath(input.projectPath),
    });
  }
  for (const wt of input.worktrees) {
    targets.push({ kind: 'worktree', label: wt.branch, path: wt.path });
  }
  return targets;
}

export function useTerminalView(input: UseTerminalViewInput) {
  const toast = useToast();
  const { webglEnabled, confinedDefault, onConfinedDefaultChange } = input;
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [restored, setRestored] = useState<PersistedTerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [hostOs, setHostOs] = useState<string | null>(null);
  const [confined, setConfined] = useState(confinedDefault);
  // The cwds of restored (dead) sessions that STILL EXIST on disk — the fail-closed
  // gate for the "start a fresh shell here" action. Probed once at mount (below).
  // Since a terminal cwd can now be ANY browsed directory (not just the repo root
  // or a worktree), a static membership check would wrongly reject browsed dirs; we
  // probe existence instead. Fail closed: a probe error leaves the cwd out of the
  // set, so the action stays disabled with a hint.
  const [restorableCwds, setRestorableCwds] = useState<ReadonlySet<string>>(new Set());
  // Per-session unread-output counts (decision 6c), mirrored from the module-level
  // session manager. Recomputed on every activity notification so an inactive tab's
  // badge updates as its background shell emits output.
  const [unread, setUnread] = useState<Readonly<Record<string, number>>>({});
  // Whether the initial `listTerminals()` has resolved — gates the layout hook's
  // order reconcile so it never prunes the persisted pane order during the load gap.
  const [loaded, setLoaded] = useState(false);

  // View-mode (tabs⇄grid) + pane order + zoom (decision 1, PR 2). Owns the layout
  // localStorage blob and the session-manager visible-set / ⌘⇧E zoom wiring.
  const layout = useTerminalLayout({ sessions, activeId, loaded });

  const targets = useMemo(() => buildTargets(input), [input]);
  const confinedAvailable = supportsConfinedTerminal(hostOs);

  // On mount, reconcile the manager cache with server truth (drop instances whose
  // shells died), show the surviving live sessions, list persisted (dead) sessions
  // as read-only restore tabs, and probe the host OS for the confined toggle. In the
  // real app the live sessions survive a nav away/back (they live in Rust + the
  // module cache); outside Tauri `listTerminals`/`listTerminalsPersisted` are empty.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([listTerminals(), listTerminalsPersisted(), getAppInfo()]).then(
      ([live, persisted, appInfo]) => {
        if (cancelled) return;
        reconcileSessions(live.map((s) => s.id));
        const liveSessions = live.filter((s) => hasSession(s.id));
        const liveIds = new Set(liveSessions.map((s) => s.id));
        // A persisted file whose session is somehow still live would double the tab;
        // prefer the live one.
        const restoredTabs = persisted.filter((p) => !liveIds.has(p.id));
        setSessions(liveSessions);
        setRestored(restoredTabs);
        setHostOs(appInfo.os);
        setLoaded(true);
        setActiveId((cur) => cur ?? liveSessions[0]?.id ?? restoredTabs[0]?.id ?? null);
        // Probe each restored cwd for existence (the fresh-shell gate). Fail-closed:
        // only cwds that still resolve to a directory become restorable.
        void Promise.all(
          restoredTabs.map((t) =>
            directoryExists(t.cwd).then(
              (ok) => [t.cwd, ok] as const,
              () => [t.cwd, false] as const,
            ),
          ),
        ).then((results) => {
          if (cancelled) return;
          setRestorableCwds(new Set(results.filter(([, ok]) => ok).map(([cwd]) => cwd)));
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Bridge the module-level activity counters into React: recompute the per-session
  // unread map on every notification (an inactive tab's shell emitting output) and
  // whenever the session list changes. Re-subscribes when `sessions` changes so the
  // closure reads the current list.
  useEffect(() => {
    const recompute = () => {
      const next: Record<string, number> = {};
      for (const s of sessions) next[s.id] = getUnread(s.id);
      setUnread(next);
    };
    recompute();
    return subscribeActivity(recompute);
  }, [sessions]);

  // The visible-set (which tabs/panes stop badging) and the focus-clear are owned by
  // `useTerminalLayout` (it knows tabs vs grid vs zoom), so no per-active-tab effect
  // lives here.

  const openPicker = useCallback(() => {
    setSpawnError(null);
    // Each open starts from the persisted sticky default; the user can still toggle
    // it for this spawn.
    setConfined(confinedDefault);
    setPickerOpen(true);
  }, [confinedDefault]);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const onConfinedChange = useCallback((next: boolean) => setConfined(next), []);

  /** Spawn a live session in `path`, add + activate its tab. Confined only when the
   *  host supports it. Returns the new session, or throws (the caller surfaces it). */
  const spawnInto = useCallback(
    async (path: string, wantConfined: boolean) => {
      const session = await openSession(
        {
          cwd: path,
          confined: wantConfined && confinedAvailable,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
        },
        webglEnabled,
      );
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
      return session;
    },
    [confinedAvailable, webglEnabled],
  );

  const pickTarget = useCallback(
    async (path: string) => {
      setSpawnError(null);
      setBusy(true);
      try {
        await spawnInto(path, confined);
        setPickerOpen(false);
        // Sticky last-choice: persist the confined choice actually used as the new
        // default (so it seeds the next picker open).
        if (confined !== confinedDefault) onConfinedDefaultChange(confined);
      } catch (err) {
        // The session cap, a rejected cwd, or a fail-closed confined refusal rejects
        // here — surface it inline in the still-open picker AND as a toast.
        setSpawnError(spawnErrorText(err));
        toast.error('Could not open terminal', err);
      } finally {
        setBusy(false);
      }
    },
    [spawnInto, confined, confinedDefault, onConfinedDefaultChange, toast],
  );

  /** Open the folder browser to pick ANY directory; close the target picker (the
   *  confined choice made there carries into the browsed spawn). */
  const openBrowse = useCallback(() => {
    setSpawnError(null);
    setPickerOpen(false);
    setBrowseOpen(true);
  }, []);
  const closeBrowse = useCallback(() => setBrowseOpen(false), []);

  /** Spawn into a browsed directory. On failure, reopen the target picker with the
   *  error inline (the confined choice preserved), matching `pickTarget`'s surface —
   *  the folder browser has already closed itself on select. */
  const pickBrowsed = useCallback(
    async (path: string) => {
      setSpawnError(null);
      setBusy(true);
      try {
        await spawnInto(path, confined);
        if (confined !== confinedDefault) onConfinedDefaultChange(confined);
      } catch (err) {
        setSpawnError(spawnErrorText(err));
        setPickerOpen(true);
        toast.error('Could not open terminal', err);
      } finally {
        setBusy(false);
      }
    },
    [spawnInto, confined, confinedDefault, onConfinedDefaultChange, toast],
  );

  const selectTab = useCallback((id: string) => setActiveId(id), []);
  const requestClose = useCallback((id: string) => setPendingClose(id), []);
  const cancelClose = useCallback(() => setPendingClose(null), []);

  /** Rename a live session (decision 5): optimistically update the local descriptor
   *  so the tab/pane relabel instantly, then persist via `terminal_set_title` (which
   *  trims + clears on blank). An empty name falls back to the cwd leaf. */
  const renameSession = useCallback((id: string, next: string) => {
    const trimmed = next.trim();
    const title = trimmed === '' ? null : trimmed;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    void setTerminalTitle(id, title);
  }, []);

  const confirmClose = useCallback(() => {
    const id = pendingClose;
    if (id === null) return;
    setPendingClose(null);
    void closeSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const remaining = sessions.filter((s) => s.id !== id);
      return remaining[0]?.id ?? restored[0]?.id ?? null;
    });
  }, [pendingClose, sessions, restored]);

  /** Dismiss a restored (read-only) tab: delete its persisted file so it does not
   *  reappear next relaunch, drop it from the list, and re-home the active tab. */
  const dismissRestored = useCallback(
    (id: string) => {
      void deleteTerminalPersisted(id);
      setRestored((prev) => prev.filter((r) => r.id !== id));
      setActiveId((cur) => {
        if (cur !== id) return cur;
        const remaining = restored.filter((r) => r.id !== id);
        return sessions[0]?.id ?? remaining[0]?.id ?? null;
      });
    },
    [restored, sessions],
  );

  /** Start a fresh live shell in a restored session's cwd (its worktree/repo still
   *  exists), then swap the read-only tab for the new live one and drop the stale
   *  persisted file. */
  const startFresh = useCallback(
    async (info: PersistedTerminalInfo) => {
      try {
        await spawnInto(info.cwd, info.confined);
        setRestored((prev) => prev.filter((r) => r.id !== info.id));
        void deleteTerminalPersisted(info.id);
      } catch (err) {
        toast.error('Could not start a fresh shell', err);
      }
    },
    [spawnInto, toast],
  );

  return {
    sessions,
    restored,
    activeId,
    unread,
    layout,
    canAddTab: !atSessionCap(sessions),
    selectTab,
    requestClose,
    dismissRestored,
    renameSession,
    pendingClose,
    confirmClose,
    cancelClose,
    picker: {
      open: pickerOpen,
      targets,
      error: spawnError,
      busy,
      confined,
      confinedAvailable,
      openPicker,
      closePicker,
      pickTarget,
      onBrowse: openBrowse,
      onConfinedChange,
    },
    browse: {
      open: browseOpen,
      // Start browsing at the project root when there is one, else the home default.
      initialPath: input.projectPath,
      close: closeBrowse,
      pick: pickBrowsed,
    },
    restore: {
      canRestore: (cwd: string) => restorableCwds.has(cwd),
      startFresh,
    },
  };
}
