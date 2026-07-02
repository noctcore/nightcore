import { useCallback, useState } from 'react';

import { parseSourceRef, type ScanTarget } from '@/lib/source-ref';

import type { AppView } from '../AppShell.types';

/** Routing + overlay open/close state for the shell. */
export function useRouting() {
  const [view, setView] = useState<AppView>('board');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Board→scan provenance navigation: the parsed `sourceRef` target the next
  // scan-view mount should preselect (run + item), consumed by the view.
  const [scanTarget, setScanTarget] = useState<ScanTarget | null>(null);

  const goto = useCallback((next: AppView) => {
    setView(next);
    setSwitcherOpen(false);
  }, []);

  /** Navigate to the scan surface that produced a task's `sourceRef`, carrying
   *  the run/item target for the view to preselect. Unknown/malformed tokens
   *  no-op (the chip doesn't render for those, but routing stays defensive). */
  const gotoSourceRef = useCallback((sourceRef: string) => {
    const target = parseSourceRef(sourceRef);
    if (target === null) return;
    setScanTarget(target);
    setView(target.view);
    setSwitcherOpen(false);
  }, []);

  return {
    view,
    goto,
    scanTarget,
    gotoSourceRef,
    clearScanTarget: useCallback(() => setScanTarget(null), []),
    switcherOpen,
    toggleSwitcher: useCallback(() => setSwitcherOpen((v) => !v), []),
    closeSwitcher: useCallback(() => setSwitcherOpen(false), []),
    newProjectOpen,
    openNewProject: useCallback(() => {
      setNewProjectOpen(true);
      setSwitcherOpen(false);
    }, []),
    closeNewProject: useCallback(() => setNewProjectOpen(false), []),
    newTaskOpen,
    openNewTask: useCallback(() => setNewTaskOpen(true), []),
    closeNewTask: useCallback(() => setNewTaskOpen(false), []),
    collapsed,
    toggleCollapsed: useCallback(() => {
      setCollapsed((v) => !v);
      setSwitcherOpen(false);
    }, []),
  };
}
