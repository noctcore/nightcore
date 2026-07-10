/** Orchestration for the global Terminal view: the tab/session list, the new-tab
 *  picker + spawn (cap-error surfaced, never crashing the picker), and the
 *  confirm-gated tab close. The view component is a thin shell over this. Live
 *  xterm instances are owned by the feature's session manager (kept alive across
 *  the shell's routed-view remounts); this hook owns only the React-facing state. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui';
import { listTerminals, type TerminalSessionInfo } from '@/lib/bridge';

import type { TerminalTarget } from '../NewTabPicker';
import {
  closeSession,
  hasSession,
  openSession,
  reconcileSessions,
} from '../terminal-session-manager';
import {
  atSessionCap,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
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
      path: input.projectPath,
      detail: input.projectPath,
    });
  }
  for (const wt of input.worktrees) {
    targets.push({ kind: 'worktree', label: wt.branch, path: wt.path });
  }
  return targets;
}

export function useTerminalView(input: UseTerminalViewInput) {
  const toast = useToast();
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);

  const targets = useMemo(() => buildTargets(input), [input]);

  // On mount, reconcile the manager cache with server truth (drop instances whose
  // shells died) and show the surviving live sessions. In the real app these
  // survive a nav away/back (they live in Rust + the module cache); outside Tauri
  // `listTerminals` is empty, so the view starts fresh.
  useEffect(() => {
    let cancelled = false;
    void listTerminals().then((live) => {
      if (cancelled) return;
      reconcileSessions(live.map((s) => s.id));
      const restorable = live.filter((s) => hasSession(s.id));
      setSessions(restorable);
      setActiveId((cur) => cur ?? restorable[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const openPicker = useCallback(() => {
    setSpawnError(null);
    setPickerOpen(true);
  }, []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const pickTarget = useCallback(
    async (path: string) => {
      setSpawnError(null);
      setBusy(true);
      try {
        const session = await openSession({
          cwd: path,
          confined: false,
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
        });
        setSessions((prev) => [...prev, session]);
        setActiveId(session.id);
        setPickerOpen(false);
      } catch (err) {
        // The session cap (or a rejected cwd) rejects here — surface it inline in
        // the still-open picker AND as a toast; never crash the picker.
        setSpawnError(spawnErrorText(err));
        toast.error('Could not open terminal', err);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const selectTab = useCallback((id: string) => setActiveId(id), []);
  const requestClose = useCallback((id: string) => setPendingClose(id), []);
  const cancelClose = useCallback(() => setPendingClose(null), []);

  const confirmClose = useCallback(() => {
    const id = pendingClose;
    if (id === null) return;
    setPendingClose(null);
    void closeSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const remaining = sessions.filter((s) => s.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [pendingClose, sessions]);

  return {
    sessions,
    activeId,
    targets,
    canAddTab: !atSessionCap(sessions),
    pickerOpen,
    spawnError,
    busy,
    pendingClose,
    openPicker,
    closePicker,
    pickTarget,
    selectTab,
    requestClose,
    confirmClose,
    cancelClose,
  };
}
