/** Orchestration for the global Terminal view: the tab/session list, restore-on-
 *  relaunch read-only tabs (decision 3), the new-tab picker + spawn (confined toggle /
 *  GPU choice), the confirm-gated close, and task→terminal integration (decision 2/3).
 *  The view is a thin shell; live xterm instances live in the session manager (kept
 *  alive across remounts), so this hook owns only the React-facing state. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  deleteTerminalPersisted,
  directoryExists,
  getAppInfo,
  listTerminals,
  listTerminalsPersisted,
  type PersistedTerminalInfo,
  type TerminalSessionInfo,
} from '@/lib/bridge';
import {
  consumePendingActivateSession,
  forgetSession,
  reconcileTerminalLinks,
} from '@/lib/terminal-links';

import { useRenameSession, useTerminalAiNaming } from '../terminal-ai-naming';
import { useTerminalDragDrop } from '../terminal-drag-drop';
import { subscribePasteRejected } from '../terminal-keymap';
import { useTerminalLayout } from '../terminal-layout';
import { setTerminalPlatform } from '../terminal-platform';
import {
  applyRenderPrefs,
  closeSession,
  getUnread,
  hasSession,
  openSession,
  reattachSession,
  reconcileSessions,
  subscribeActivity,
} from '../terminal-session-manager';
import {
  atSessionCap,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  resolveFontSize,
  resolveScrollback,
  supportsConfinedTerminal,
} from '../terminal-shared';
import { useTerminalShortcuts } from '../terminal-shortcuts';
import { useTerminalTasks } from '../terminal-tasks';
import { buildTargets, spawnErrorText } from '../terminal-view-helpers';
import { useCreateWorktree, useTerminalOpenRequest } from '../terminal-worktree-open';
import type { UseTerminalViewInput } from './TerminalView.types';

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
  // gate for the "start a fresh shell here" action (a browsed cwd can be anywhere, so
  // we probe existence at mount rather than a static membership check).
  const [restorableCwds, setRestorableCwds] = useState<ReadonlySet<string>>(new Set());
  // Per-session unread-output counts (decision 6c), mirrored from the module-level
  // session manager on every activity notification.
  const [unread, setUnread] = useState<Readonly<Record<string, number>>>({});
  // Whether the initial `listTerminals()` has resolved — gates the layout hook's order
  // reconcile so it never prunes the persisted pane order during the load gap.
  const [loaded, setLoaded] = useState(false);

  // View-mode (tabs⇄grid) + pane order + zoom (decision 1, PR 2). Owns the layout
  // localStorage blob and the session-manager visible-set / ⌘⇧E zoom wiring.
  const layout = useTerminalLayout({ sessions, activeId, loaded });
  // Drag a file onto a pane → type its shell-escaped absolute path (round-2 PR C).
  const dragDrop = useTerminalDragDrop({ sessions });

  const targets = useMemo(
    () => buildTargets(input.projectPath, input.projectName, input.worktrees),
    [input.projectPath, input.projectName, input.worktrees],
  );
  const confinedAvailable = supportsConfinedTerminal(hostOs);

  // On mount, reconcile the manager cache + link store with server truth, show the
  // surviving live sessions, list persisted (dead) sessions as read-only restore tabs,
  // and probe the host OS for the confined toggle. Outside Tauri the lists are empty.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([listTerminals(), listTerminalsPersisted(), getAppInfo()]).then(
      async ([live, persisted, appInfo]) => {
        if (cancelled) return;
        reconcileSessions(live.map((s) => s.id));
        // Drop task-links / ungoverned markers for sessions that didn't survive
        // (decision 2/3) — the store is web-side, seeded from live sessions.
        reconcileTerminalLinks(live.map((s) => s.id));
        // Reattach live sessions with no local xterm — the detached-daemon reattach on
        // relaunch (PR 6). In the in-process default `live` is empty here, so this is a
        // no-op (no regression when the daemon is off); a lost session read-only-restores.
        const missing = live.filter((s) => !hasSession(s.id));
        await Promise.all(missing.map((s) => reattachSession(s, webglEnabled).catch(() => undefined)));
        if (cancelled) return;
        const liveSessions = live.filter((s) => hasSession(s.id));
        const liveIds = new Set(liveSessions.map((s) => s.id));
        // A persisted file whose session is somehow still live would double the tab;
        // prefer the live one.
        const restoredTabs = persisted.filter((p) => !liveIds.has(p.id));
        setSessions(liveSessions);
        setRestored(restoredTabs);
        setHostOs(appInfo.os);
        // Refine the shortcut/keymap platform from the Rust host OS (spec PR 3a) —
        // the navigator default seeded it before this resolved.
        setTerminalPlatform(appInfo.os);
        setLoaded(true);
        // A board terminal-chip click routes here + asks for a specific tab; honor it
        // when the requested session is live, else fall back to the first tab.
        const pending = consumePendingActivateSession();
        const focus = pending !== null && liveIds.has(pending) ? pending : null;
        setActiveId((cur) => cur ?? focus ?? liveSessions[0]?.id ?? restoredTabs[0]?.id ?? null);
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
  // unread map on every notification, and whenever the session list changes.
  useEffect(() => {
    const recompute = () => {
      const next: Record<string, number> = {};
      for (const s of sessions) next[s.id] = getUnread(s.id);
      setUnread(next);
    };
    recompute();
    return subscribeActivity(recompute);
  }, [sessions]);

  // Reactive render prefs (spec PR 3d): resolve the Settings font size / scrollback
  // (null ⇒ shipped defaults, clamped) and push them to every live terminal via the
  // session manager (xterm applies option changes live, no reopen).
  const fontSize = resolveFontSize(input.fontSize);
  const scrollback = resolveScrollback(input.scrollback);
  useEffect(() => {
    applyRenderPrefs({ fontSize, scrollback });
  }, [fontSize, scrollback]);

  // Surface a dropped over-cap paste (spec PR 3b) as a toast — the session manager's
  // keymap is module-level, so it notifies through this subscription.
  useEffect(
    () =>
      subscribePasteRejected(() => {
        toast.push({
          tone: 'info',
          title: 'Paste too large',
          description: 'Clipboard content over 1 MB was not pasted into the terminal.',
        });
      }),
    [toast],
  );

  // The visible-set + focus-clear are owned by `useTerminalLayout` (tabs vs grid vs
  // zoom), so no per-active-tab effect lives here.

  const openPicker = useCallback(() => {
    setSpawnError(null);
    // Each open starts from the persisted sticky default (toggleable per spawn).
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
        // Sticky last-choice: persist the confined choice actually used.
        if (confined !== confinedDefault) onConfinedDefaultChange(confined);
      } catch (err) {
        // Cap / rejected cwd / fail-closed confined refusal — surface inline + toast.
        setSpawnError(spawnErrorText(err));
        toast.error('Could not open terminal', err);
      } finally {
        setBusy(false);
      }
    },
    [spawnInto, confined, confinedDefault, onConfinedDefaultChange, toast],
  );

  /** Open the folder browser to pick ANY directory; close the target picker. */
  const openBrowse = useCallback(() => {
    setSpawnError(null);
    setPickerOpen(false);
    setBrowseOpen(true);
  }, []);
  const closeBrowse = useCallback(() => setBrowseOpen(false), []);

  /** Spawn into a browsed directory. On failure, reopen the target picker with the
   *  error inline (the folder browser has already closed itself on select). */
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

  // Rename (decision 5 + round-2 PR A precedence) + AI tab auto-naming wiring, both
  // extracted to `terminal-ai-naming` so this hook stays under the file-size ratchet.
  const renameSession = useRenameSession(setSessions);
  useTerminalAiNaming(input.aiNaming, setSessions);

  const confirmClose = useCallback(() => {
    const id = pendingClose;
    if (id === null) return;
    setPendingClose(null);
    forgetSession(id); // drop any task-link / ungoverned marker (decision 2/3)
    void closeSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const remaining = sessions.filter((s) => s.id !== id);
      return remaining[0]?.id ?? restored[0]?.id ?? null;
    });
  }, [pendingClose, sessions, restored]);

  /** Drop a restored (read-only) tab: delete its persisted file + remove it from the
   *  list. Shared by dismiss + the fresh-shell / resume swaps. */
  const consumeRestored = useCallback((id: string) => {
    void deleteTerminalPersisted(id);
    setRestored((prev) => prev.filter((r) => r.id !== id));
  }, []);

  /** Dismiss a restored tab and re-home the active tab off it. */
  const dismissRestored = useCallback(
    (id: string) => {
      consumeRestored(id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        const remaining = restored.filter((r) => r.id !== id);
        return sessions[0]?.id ?? remaining[0]?.id ?? null;
      });
    },
    [consumeRestored, restored, sessions],
  );

  /** Start a fresh live shell in a restored session's cwd, then swap the read-only tab. */
  const startFresh = useCallback(
    async (info: PersistedTerminalInfo) => {
      try {
        await spawnInto(info.cwd, info.confined);
        consumeRestored(info.id);
      } catch (err) {
        toast.error('Could not start a fresh shell', err);
      }
    },
    [spawnInto, consumeRestored, toast],
  );

  // Task→terminal integration (decision 2/3): pickable list, ungoverned / linked-title
  // maps, and the inject / launch / resume handlers.
  const tasks = useTerminalTasks({
    sessions,
    tasks: input.tasks,
    projectPath: input.projectPath,
    yoloLaunch: input.yoloLaunch,
    renameSession,
    spawnInto,
    consumeRestored,
  });

  // Create-new-worktree flow (spec PR 5a): the picker's "Create new worktree…" dialog +
  // its create-then-spawn. Carries the picker's current confined choice into the shell.
  const createWorktree = useCreateWorktree({ spawnInto, confined });

  // Open-terminal-here (spec PR 5b): consume a pending request from the Worktrees view
  // once the initial load settles, spawning a shell in that cwd (sticky-default confined).
  useTerminalOpenRequest({ loaded, spawnInto, confined: confinedDefault });

  const canAddTab = !atSessionCap(sessions);

  // Cockpit shortcuts (spec PR 3a): ⌘T opens the picker, ⌘W closes the active tab
  // (through the confirm dialog). Bound only while this view is mounted; ⌘⇧E zoom is
  // owned by `useTerminalLayout`. The keymap separately swallows the same chords so
  // xterm never forwards them to the PTY.
  useTerminalShortcuts({
    activeId,
    canAddTab,
    onNewTab: openPicker,
    onCloseActive: requestClose,
  });

  return {
    sessions,
    restored,
    activeId,
    unread,
    layout,
    dropTargetId: dragDrop.dropTargetId,
    canAddTab,
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
      // The "Create new worktree…" entry only shows inside a project (worktrees need a
      // repo); undefined otherwise so the picker hides it. Closes the picker first.
      onCreateWorktree:
        input.projectPath !== null
          ? () => {
              closePicker();
              createWorktree.openCreate();
            }
          : undefined,
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
    tasks,
    createWorktree,
  };
}
