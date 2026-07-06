/**
 * The open-PR list state for the workspace's persistent left rail — split out
 * of the PrReviewView mega-hook along its "open-PR list" concern.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { listOpenPrs, type PrSummary } from '@/lib/bridge';

/** The initial fetch cap and the hard ceiling (mirrors the Rust
 *  `PR_LIST_DEFAULT_LIMIT` / `PR_LIST_MAX_LIMIT`). "Load more" doubles the cap and
 *  refetches — the command returns the newest `limit` PRs with no cursor, so a
 *  doubled-cap refetch is the simple correct shape (appending would risk dupes /
 *  reordering against a moving list). */
const INITIAL_PR_LIMIT = 50;
const MAX_PR_LIMIT = 200;

/** The open-PR list state for the left rail. */
export interface OpenPrs {
  /** The active project's open pull requests, newest first. */
  prs: PrSummary[];
  /** True while the list is being (re)fetched from scratch (initial / refresh). */
  loading: boolean;
  /** True while a "load more" doubled-cap refetch is in flight (rows stay up). */
  loadingMore: boolean;
  /** A fetch failure (gh missing / no remote / auth), or null. */
  error: string | null;
  /** Whether more PRs may exist beyond the current cap (the fetch filled it and
   *  the cap is below the ceiling). */
  hasMore: boolean;
  /** Re-fetch the list at the current cap. */
  refresh: () => void;
  /** Grow the cap (×2, clamped to the ceiling) and refetch. No-op at the ceiling. */
  loadMore: () => void;
}

/**
 * Fetch the active project's open pull requests for the persistent left rail.
 * Fetches on mount / project arrival, on `refresh()`, and on `loadMore()` (which
 * doubles the cap) — the view is a permanent workspace, so freshness comes from
 * the explicit actions rather than a per-screen remount. A gh failure becomes
 * `error` (the picker surfaces it inline) — the typed-number escape hatch still
 * works, so a listing failure never blocks starting a review.
 */
export function useOpenPrs(enabled: boolean): OpenPrs {
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(INITIAL_PR_LIMIT);
  const [reloadKey, setReloadKey] = useState(0);
  // A cap-growth fetch shows the footer spinner (loadingMore); an initial/refresh
  // fetch shows the top-level loader. The ref lets the shared effect tell which
  // triggered it without adding a state read to its deps.
  const loadMoreRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const isMore = loadMoreRef.current;
    loadMoreRef.current = false;
    if (isMore) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await listOpenPrs(limit);
        if (!cancelled) {
          setPrs(list);
          // The fetch filled the cap and the cap is below the ceiling ⇒ more may exist.
          setHasMore(list.length >= limit && limit < MAX_PR_LIMIT);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          // A load-more failure keeps the already-loaded rows up (the
          // `loadingMore` "rows stay put" contract) — only a from-scratch
          // (initial / refresh) fetch clears the list. Either way stop offering
          // more so the footer settles out of the spinner.
          if (!isMore) setPrs([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey, limit]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const loadMore = useCallback(() => {
    setLimit((n) => {
      const next = Math.min(n * 2, MAX_PR_LIMIT);
      if (next !== n) loadMoreRef.current = true;
      return next;
    });
  }, []);
  return { prs, loading, loadingMore, error, hasMore, refresh, loadMore };
}
