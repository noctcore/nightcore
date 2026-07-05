/** Presentation helpers + collapse state for the PR workspace panel. */
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type PrChangedFile, prChangedFiles } from '@/lib/bridge';

import type { ChangedFilesOverride } from './PrWorkspace.types';

/** A GitHub label color is a 6-hex string with no `#`. Validate before use so an
 *  unexpected value can never become raw CSS. */
export function labelChipStyle(color: string): CSSProperties {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return {}; // fall back to the neutral chip classes
  }
  return {
    backgroundColor: `#${color}22`,
    borderColor: `#${color}66`,
    color: `#${color}`,
  };
}

/** Format a gh ISO-8601 timestamp as a short local date (e.g. "Apr 9, 2026"), or
 *  null when it can't be parsed (so the caller can omit it). */
export function formatPrDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Bodies longer than this collapse by default (untrusted contributor markdown
 *  shouldn't shove the review section below the fold). */
const COLLAPSE_THRESHOLD = 700;

export interface DescriptionCollapse {
  /** True when the body is long enough to collapse at all. */
  collapsible: boolean;
  /** True when the full body is currently shown. */
  expanded: boolean;
  toggle: () => void;
}

/** Collapse state for the PR description. Keyed by PR number so switching PRs
 *  returns to the collapsed default without any effect/remount choreography. */
export function useDescriptionCollapse(
  prNumber: number,
  body: string,
): DescriptionCollapse {
  const collapsible = body.trim().length > COLLAPSE_THRESHOLD;
  const [expandedFor, setExpandedFor] = useState<number | null>(null);
  const expanded = !collapsible || expandedFor === prNumber;
  return {
    collapsible,
    expanded,
    toggle: () => setExpandedFor(expanded ? null : prNumber),
  };
}

export interface ChangedFilesState {
  /** True when the file list is expanded for THIS PR. */
  expanded: boolean;
  toggle: () => void;
  /** Re-run the on-expand fetch after a failure, without collapsing the section
   *  (the error-state Retry affordance). A no-op once a fetch has succeeded. */
  retry: () => void;
  /** The changed files (empty until loaded / on error). */
  files: PrChangedFile[];
  /** True while the on-expand fetch is in flight. */
  loading: boolean;
  /** A fetch failure (gh missing / no remote), or null. */
  error: string | null;
  /** The changed-file count once known for this PR, else `null` (pre-fetch) — the
   *  header shows "Files" until it resolves to "N files". */
  count: number | null;
}

/**
 * Lazily load a PR's changed files, fetched the first time the expander opens for
 * that PR (keyed by number, so switching PRs re-collapses without effect
 * choreography — matching {@link useDescriptionCollapse}). No polling; the gh
 * call is bounded + capped Rust-side. `override` supplies the files directly for
 * stories/tests (the `statusOverride` pattern), suppressing the fetch.
 */
export function useChangedFiles(
  prNumber: number,
  override?: ChangedFilesOverride,
): ChangedFilesState {
  const [expandedFor, setExpandedFor] = useState<number | null>(null);
  const [files, setFiles] = useState<PrChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping the epoch forces the on-expand fetch effect to re-run — the Retry
  // affordance in the error branch, without a collapse/re-expand round trip.
  const [epoch, setEpoch] = useState(0);
  const loadedForRef = useRef<number | null>(null);
  const expanded = expandedFor === prNumber;

  useEffect(() => {
    if (override !== undefined) return; // override seam: never fetch
    if (!expanded) return;
    if (loadedForRef.current === prNumber) return; // already loaded this PR
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await prChangedFiles(prNumber);
        if (!cancelled) {
          setFiles(list);
          loadedForRef.current = prNumber;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setFiles([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, prNumber, override, epoch]);

  const toggle = () => setExpandedFor(expanded ? null : prNumber);
  // On error `loadedForRef` stays null (nothing cached), so bumping the epoch
  // re-runs the effect while `expanded` stays true. Once a fetch has succeeded
  // the ref short-circuits the effect, so this is inert (it's only surfaced in
  // the error branch anyway).
  const retry = useCallback(() => setEpoch((n) => n + 1), []);

  if (override !== undefined) {
    const overrideFiles = override.files ?? [];
    return {
      expanded,
      toggle,
      retry,
      files: overrideFiles,
      loading: override.loading ?? false,
      error: override.error ?? null,
      count: override.files !== undefined ? overrideFiles.length : null,
    };
  }

  return {
    expanded,
    toggle,
    retry,
    files,
    loading,
    error,
    count: loadedForRef.current === prNumber ? files.length : null,
  };
}
