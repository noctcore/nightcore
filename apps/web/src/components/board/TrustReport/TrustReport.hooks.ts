/** State + orchestration for the drawer's Trust band: the fetch-on-mount report,
 *  the native-save export flow (`write_trust_report`, Rust-side atomic write), and
 *  the lazy canonical-markdown preview. Lifted per the `usePrStatus` idiom — a
 *  fetch on mount / per task id, an `override` seam for stories/tests, and a
 *  memoized view so the band's state can cross the memoized `TaskDetailChrome`
 *  without churning on a per-frame stream flush. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Task, TrustReport as TrustReportData } from '@/lib/bridge';
import { exportTrustReport, trustReport, trustReportMarkdown } from '@/lib/bridge';

import type { TrustReportView } from './TrustReport.types';

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Format a USD amount for the receipt (2 dp — the drawer summary; the export
 *  markdown keeps 4 dp for small agent costs). */
export function formatUsd(x: number): string {
  return `$${x.toFixed(2)}`;
}

/** Compact a large token count (`128400` → `128.4k`) for the summary chips. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Suggest a safe `*.md` filename stem from the task/report title — lowercased,
 *  non-alphanumerics folded to single dashes, capped, and prefixed so the save
 *  dialog opens on a sensible default (`trust-report-wire-up-auth-guard`). */
export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `trust-report${slug.length > 0 ? `-${slug}` : ''}`;
}

/** Fetch + orchestrate a task's Trust Report. `override` is the story/test seam:
 *  when provided (including `null`) no command fires and it renders directly. The
 *  OWNER mounts this only for a task that has run (the band is gated on
 *  `!kindEditable` in TaskDetail), so a fresh backlog task never fetches. */
export function useTrustReport(task: Task, override?: TrustReportData | null): TrustReportView {
  const taskId = task.id;
  const suggestedName = exportFileName(task.title);
  const skip = override !== undefined;

  const [report, setReport] = useState<TrustReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Task-switch reset (the usePrStatus belt): the hook instance survives a task
  // switch, so task A's report/export/preview snapshot must not render against B
  // until B's fetch lands. Reset synchronously before paint.
  const [lastTaskId, setLastTaskId] = useState(taskId);
  if (lastTaskId !== taskId) {
    setLastTaskId(taskId);
    setReport(null);
    setFetchError(null);
    setUnavailable(false);
    setExportPending(false);
    setExportError(null);
    setSavedPath(null);
    setPreviewOpen(false);
    setPreviewMarkdown(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }

  useEffect(() => {
    if (skip) return;
    let stale = false;
    setLoading(true);
    setFetchError(null);
    trustReport(taskId).then(
      (next) => {
        if (stale) return;
        setReport(next);
        setUnavailable(next === null);
        setLoading(false);
      },
      (err: unknown) => {
        if (stale) return;
        console.error('trust_report failed', err);
        setFetchError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [skip, taskId]);

  // Lazily fetch the canonical markdown the first time the preview opens.
  useEffect(() => {
    if (!previewOpen || previewMarkdown !== null) return;
    let stale = false;
    setPreviewLoading(true);
    setPreviewError(null);
    trustReportMarkdown(taskId, false).then(
      (md) => {
        if (stale) return;
        setPreviewMarkdown(md);
        setPreviewLoading(false);
      },
      (err: unknown) => {
        if (stale) return;
        setPreviewError(errorText(err));
        setPreviewLoading(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [previewOpen, previewMarkdown, taskId]);

  const runExport = useCallback(() => {
    setExportPending(true);
    setExportError(null);
    setSavedPath(null);
    void exportTrustReport(taskId, suggestedName).then(
      (result) => {
        setExportPending(false);
        if (result.saved) setSavedPath(result.path);
      },
      (err: unknown) => {
        setExportPending(false);
        setExportError(errorText(err));
      },
    );
  }, [taskId, suggestedName]);

  const togglePreview = useCallback(() => setPreviewOpen((open) => !open), []);

  return useMemo<TrustReportView>(() => {
    const exportView = {
      run: runExport,
      pending: exportPending,
      error: exportError,
      savedPath,
    };
    const previewView = {
      open: previewOpen,
      toggle: togglePreview,
      markdown: previewMarkdown,
      loading: previewLoading,
      error: previewError,
    };
    if (override !== undefined) {
      return {
        report: override,
        loading: false,
        unavailable: override === null,
        error: null,
        export: exportView,
        preview: previewView,
      };
    }
    return {
      report,
      loading,
      unavailable,
      error: fetchError,
      export: exportView,
      preview: previewView,
    };
  }, [
    override,
    report,
    loading,
    unavailable,
    fetchError,
    runExport,
    exportPending,
    exportError,
    savedPath,
    previewOpen,
    togglePreview,
    previewMarkdown,
    previewLoading,
    previewError,
  ]);
}
