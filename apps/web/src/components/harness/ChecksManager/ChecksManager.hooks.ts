/** The Checks Manager view model: load the active project's armed checks, run them
 *  on demand, and enable/disable/edit/remove them — every mutation returns the
 *  refreshed {@link ArmedChecksState}, which becomes the new authoritative state. */
import { useCallback, useEffect, useState } from 'react';

import {
  type ArmedCheck,
  type ArmedChecksState,
  listArmedChecks,
  removeArmedCheck,
  runArmedChecksNow,
  setArmedCheckEnabled,
  updateArmedCheck,
} from '@/lib/bridge';

import type { ChecksEditDraft, ChecksManagerVM } from './ChecksManager.types';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Own the armed-checks panel state. Loads on mount; each mutation swaps in the
 *  backend's freshly-projected state so the list, last results, and run banner stay
 *  consistent after any edit. */
export function useChecksManager(): ChecksManagerVM {
  const [state, setState] = useState<ArmedChecksState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ChecksEditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [removeTarget, setRemoveTarget] = useState<ArmedCheck | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await listArmedChecks();
        if (live) setState(next);
      } catch (err) {
        if (live) setLoadError(errMessage(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const start = useCallback(() => {
    setRunning(true);
    setRunError(null);
    void (async () => {
      try {
        setState(await runArmedChecksNow());
      } catch (err) {
        setRunError(errMessage(err));
      } finally {
        setRunning(false);
      }
    })();
  }, []);

  const toggle = useCallback((name: string, enabled: boolean) => {
    setPendingName(name);
    setActionError(null);
    void (async () => {
      try {
        setState(await setArmedCheckEnabled(name, enabled));
      } catch (err) {
        setActionError(errMessage(err));
      } finally {
        setPendingName(null);
      }
    })();
  }, []);

  const startEdit = useCallback((check: ArmedCheck) => {
    setEditError(null);
    setDraft({
      originalName: check.name,
      name: check.name,
      kind: check.kind,
      command: check.command,
      timeoutMs: check.timeoutMs != null ? String(check.timeoutMs) : '',
      enabled: check.enabled,
    });
  }, []);

  const changeEdit = useCallback((patch: Partial<ChecksEditDraft>) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  const cancelEdit = useCallback(() => {
    if (saving) return;
    setDraft(null);
    setEditError(null);
  }, [saving]);

  const saveEdit = useCallback(() => {
    if (draft === null) return;
    const trimmedTimeout = draft.timeoutMs.trim();
    const parsedTimeout = trimmedTimeout === '' ? null : Number(trimmedTimeout);
    if (parsedTimeout !== null && (!Number.isFinite(parsedTimeout) || parsedTimeout < 0)) {
      setEditError('Timeout must be a positive number of milliseconds (or blank for the default).');
      return;
    }
    setSaving(true);
    setEditError(null);
    void (async () => {
      try {
        const next = await updateArmedCheck(draft.originalName, {
          name: draft.name.trim(),
          kind: draft.kind,
          command: draft.command.trim(),
          enabled: draft.enabled,
          timeoutMs: parsedTimeout,
          configPath: null,
        });
        setState(next);
        setDraft(null);
      } catch (err) {
        setEditError(errMessage(err));
      } finally {
        setSaving(false);
      }
    })();
  }, [draft]);

  const requestRemove = useCallback((check: ArmedCheck) => {
    setActionError(null);
    setRemoveTarget(check);
  }, []);

  const cancelRemove = useCallback(() => {
    if (removeBusy) return;
    setRemoveTarget(null);
  }, [removeBusy]);

  const confirmRemove = useCallback(() => {
    if (removeTarget === null) return;
    const name = removeTarget.name;
    setRemoveBusy(true);
    void (async () => {
      try {
        setState(await removeArmedCheck(name));
        setRemoveTarget(null);
      } catch (err) {
        setActionError(errMessage(err));
      } finally {
        setRemoveBusy(false);
      }
    })();
  }, [removeTarget]);

  return {
    loading: state === null && loadError === null,
    loadError,
    checks: state?.checks ?? [],
    lastRun: state?.lastRun ?? null,
    actionError,
    pendingName,
    run: { running, error: runError, start },
    toggle,
    edit: {
      draft,
      saving,
      error: editError,
      start: startEdit,
      change: changeEdit,
      cancel: cancelEdit,
      save: saveEdit,
    },
    remove: {
      target: removeTarget,
      busy: removeBusy,
      request: requestRemove,
      cancel: cancelRemove,
      confirm: confirmRemove,
    },
  };
}
