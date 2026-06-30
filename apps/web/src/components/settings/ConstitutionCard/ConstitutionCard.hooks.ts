/** State and bridge actions for the Constitution editor card (load/edit/save/regenerate). */
import { useCallback, useEffect, useState } from 'react';
import {
  getContextPack,
  regenerateContextPack,
  setContextPack,
} from '@/lib/bridge';
import type { ConstitutionMode } from './ConstitutionCard.types';

/** The state and actions the Constitution editor card binds to. */
export interface ConstitutionCardState {
  /** The current (possibly edited) pack content. */
  content: string;
  /** Edit the content in place (Edit mode). */
  onContentChange: (next: string) => void;
  /** True until the initial load resolves. */
  loading: boolean;
  /** True while a save/regenerate is in flight (disables the actions). */
  busy: boolean;
  /** Which action is in flight (drives the per-button spinner/label), or null. */
  busyAction: 'save' | 'regenerate' | null;
  /** True when the editor has unsaved edits vs. what is persisted on disk. */
  dirty: boolean;
  /** The active editor view. */
  mode: ConstitutionMode;
  setMode: (mode: ConstitutionMode) => void;
  /** Persist the current content as the project's `context.md`. */
  save: () => void;
  /** Re-assemble the pack from on-disk sources, persist it, and load it in. */
  regenerate: () => void;
  /** The last load/save/regenerate error, or null. */
  error: string | null;
}

/**
 * All state for the Constitution editor (folder-per-component: no state in the
 * component body). Loads the active project's `context.md` once, tracks edits vs.
 * the persisted snapshot for the dirty flag, and exposes save/regenerate that go
 * through the bridge and re-sync the persisted snapshot on success.
 */
export function useConstitutionCard(projectActive: boolean): ConstitutionCardState {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  // Which action is in flight (drives per-button spinner/label); `busy` is derived.
  const [busyAction, setBusyAction] = useState<'save' | 'regenerate' | null>(null);
  const busy = busyAction !== null;
  const [mode, setMode] = useState<ConstitutionMode>('preview');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectActive) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void getContextPack()
      .then((pack) => {
        if (!alive) return;
        const text = pack ?? '';
        setContent(text);
        setSaved(text);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectActive]);

  const save = useCallback(() => {
    setBusyAction('save');
    void setContextPack(content)
      .then(() => {
        setSaved(content);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusyAction(null));
  }, [content]);

  const regenerate = useCallback(() => {
    setBusyAction('regenerate');
    void regenerateContextPack()
      .then((next) => {
        setContent(next);
        setSaved(next);
        setError(null);
        setMode('preview');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusyAction(null));
  }, []);

  return {
    content,
    onContentChange: setContent,
    loading,
    busy,
    busyAction,
    dirty: content !== saved,
    mode,
    setMode,
    save,
    regenerate,
    error,
  };
}
