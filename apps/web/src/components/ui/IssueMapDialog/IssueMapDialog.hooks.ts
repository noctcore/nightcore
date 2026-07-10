/** State + effects for the IssueMapDialog: the preview fetch, the supersede
 *  checkbox, the single-flight export, the live `nc:issue-map` progress, and the
 *  terminal result. All state lives here so the `.tsx` shell stays a thin,
 *  purely-presentational layer (the folder-per-component `no-state-in-body`
 *  rule). Modeled on `useCreatePrDialog`. */
import { useCallback, useEffect, useState } from 'react';

import type { IssueMapPreview, IssueMapResult, IssueMapScanKind } from '@/lib/bridge';
import { exportIssueMap, onIssueMapEvent, previewIssueMap } from '@/lib/bridge';

import type { IssueMapDialogOverride } from './IssueMapDialog.types';

/** Live progress counters for the sequential create+attach loop. */
export interface IssueMapProgressView {
  created: number;
  total: number;
}

/** Everything the IssueMapDialog shell renders from. */
export interface IssueMapDialogView {
  /** True while the preview is being built (the deterministic plan + LLM pass +
   *  prior-map discovery run Rust-side). */
  loading: boolean;
  /** A preview-fetch failure (bad run / no gh / no active project); the dialog
   *  shows it in place of the preview and offers a retry via re-open. */
  loadError: string | null;
  /** The full preview payload once built (`null` while loading / on error). */
  preview: IssueMapPreview | null;
  /** Opt-in: close the superseded prior map + its open sub-issues after the new
   *  map lands (only offered when `preview.supersedes` is set). */
  closeSuperseded: boolean;
  setCloseSuperseded: (v: boolean) => void;
  /** True while the export (the GitHub writes) is in flight. */
  submitting: boolean;
  /** Live `created k / N` progress during the export, else `null`. */
  progress: IssueMapProgressView | null;
  /** The terminal result once the export settles: full success, PARTIAL (a
   *  mid-run stop — nothing deleted), or DEGRADED linkage (task-list fallback).
   *  A HARD failure (parent create / single-flight) lands on `exportError`. */
  result: IssueMapResult | null;
  /** A hard export rejection (parent never landed / an export is already
   *  running); the dialog surfaces it inline and a fresh confirm can retry. */
  exportError: string | null;
  /** Whether Confirm may fire: a built preview, not submitting, not already
   *  settled. */
  canConfirm: boolean;
  /** Fire the export (the irreversible GitHub write). No-op unless `canConfirm`. */
  confirm: () => void;
  /** Dismiss the dialog — a NO-OP while the export is in flight (an orphaned
   *  mid-export unmount would swallow the terminal result). */
  requestClose: () => void;
}

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Orchestrate the IssueMapDialog. On open (with a run) it fetches the preview;
 *  Confirm runs the single-flight export and threads the previewed narrative +
 *  timestamp straight back so the posted bytes match the preview. The live
 *  `nc:issue-map` ticks drive the progress counter; the resolved `IssueMapResult`
 *  (success / partial / degraded) or a hard rejection is the terminal state. */
export function useIssueMapDialog({
  open,
  scanKind,
  runId,
  onClose,
  override,
}: {
  open: boolean;
  scanKind: IssueMapScanKind;
  runId: string | null;
  onClose: () => void;
  override?: IssueMapDialogOverride;
}): IssueMapDialogView {
  // When a story/test seeds `override`, NO command fires and the seeded state
  // renders directly (the `useTrustReport` override idiom).
  const skip = override !== undefined;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(override?.loadError ?? null);
  const [preview, setPreview] = useState<IssueMapPreview | null>(override?.preview ?? null);
  const [closeSuperseded, setCloseSuperseded] = useState(false);
  const [submitting, setSubmitting] = useState(override?.submitting ?? false);
  const [progress, setProgress] = useState<IssueMapProgressView | null>(
    override?.progress ?? null,
  );
  const [result, setResult] = useState<IssueMapResult | null>(override?.result ?? null);
  const [exportError, setExportError] = useState<string | null>(override?.exportError ?? null);

  // Reset + fetch the preview on open (or when the run/kind changes while open).
  // A stale guard drops a late resolve after a close/switch (the WorktreeView
  // preview-fetch discipline). Skipped entirely under a seeded override.
  useEffect(() => {
    if (skip || !open || runId === null) return;
    setLoadError(null);
    setPreview(null);
    setCloseSuperseded(false);
    setSubmitting(false);
    setProgress(null);
    setResult(null);
    setExportError(null);
    setLoading(true);
    let stale = false;
    void previewIssueMap(scanKind, runId)
      .then((p) => {
        if (stale) return;
        setPreview(p);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setLoadError(errorText(err));
      })
      .finally(() => {
        if (stale) return;
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [skip, open, scanKind, runId]);

  // Consume the transient `nc:issue-map` ticks while the dialog is open, ignoring
  // foreign runs. Purely cosmetic — the resolved result is the source of truth.
  useEffect(() => {
    if (skip || !open) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void onIssueMapEvent((ev) => {
      if (!alive) return;
      if (runId !== null && ev.runId !== runId) return;
      setProgress({ created: ev.created, total: ev.total });
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [skip, open, runId]);

  const canConfirm =
    !loading && loadError === null && preview !== null && !submitting && result === null;

  const confirm = useCallback(() => {
    if (runId === null || preview === null || submitting || result !== null) return;
    setSubmitting(true);
    setExportError(null);
    setProgress({ created: 0, total: preview.total });
    void exportIssueMap(scanKind, runId, preview.generatedAt, preview.narrative, closeSuperseded)
      .then((res) => setResult(res))
      .catch((err: unknown) => setExportError(errorText(err)))
      .finally(() => setSubmitting(false));
  }, [runId, preview, submitting, result, scanKind, closeSuperseded]);

  // Submitting-aware close (gated HERE — the shared Modal fires onClose
  // unconditionally on Esc/backdrop).
  const requestClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  return {
    loading,
    loadError,
    preview,
    closeSuperseded,
    setCloseSuperseded,
    submitting,
    progress,
    result,
    exportError,
    canConfirm,
    confirm,
    requestClose,
  };
}
