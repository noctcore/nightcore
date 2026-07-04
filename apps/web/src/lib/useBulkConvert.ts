/**
 * The bulk convert-all state machine, hoisted out of the Insight and PR-Review
 * view hooks (the two scan siblings that offer "convert every open finding →
 * tasks"). Both had re-implemented the exact same machinery — the progress
 * counters, the synchronous re-entrancy guard, the resilient per-item loop that
 * records rejections and keeps going, and the aria-live / inline status strings.
 *
 * `apps/web/src/lib/` is the only place the `no-cross-feature-imports` lint permits
 * cross-family sharing, so this lives here alongside `useScanRun`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

/** The convert-all progress a caller feeds into its RESULTS toolbar / view model. */
export interface BulkConvertProgress {
  done: number;
  total: number;
  failed: number;
}

/** Everything {@link useBulkConvert} exposes to a scan view hook. */
export interface BulkConvertApi {
  bulkConverting: boolean;
  bulkProgress: BulkConvertProgress;
  /** Polite aria-live announcement ('' when idle, "Converting k/N…" in flight). */
  bulkStatusMessage: string;
  /** Inline (visible) failure summary when conversions rejected, else `null`. */
  bulkError: string | null;
  /** Clear the counters so a prior run's summary can't bleed into a new view. */
  resetBulk: () => void;
  /** Convert every target in sequence; rejections are recorded, not fatal. */
  convertAll: (targets: readonly { id: string }[]) => void;
}

/**
 * Own the bulk convert-all counters, guard, loop, and status strings.
 *
 * @param convert the family's single-item convert (read through a ref, so a fresh
 *   closure each render — e.g. one rebound on `stream.runId` — is always current).
 * @param errorLabel the `console.error` label for a per-item rejection.
 */
export function useBulkConvert(
  convert: (id: string) => Promise<unknown>,
  errorLabel: string,
): BulkConvertApi {
  const [bulkConverting, setBulkConverting] = useState(false);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkFailed, setBulkFailed] = useState(0);
  // Synchronous re-entrancy guard: a sub-frame double-click can't start a second
  // concurrent conversion loop (which would double-count progress).
  const convertAllInFlight = useRef(false);

  const convertRef = useRef(convert);
  convertRef.current = convert;

  // Clear the convert-all counters so a prior run's "Converted k/N" summary can't
  // bleed into a freshly entered results view (a new run or a history select).
  const resetBulk = useCallback(() => {
    setBulkTotal(0);
    setBulkDone(0);
    setBulkFailed(0);
  }, []);

  const convertAll = useCallback(
    (targets: readonly { id: string }[]) => {
      if (convertAllInFlight.current) return;
      if (targets.length === 0) return;
      convertAllInFlight.current = true;
      setBulkTotal(targets.length);
      setBulkDone(0);
      setBulkFailed(0);
      setBulkConverting(true);
      void (async () => {
        try {
          for (const t of targets) {
            try {
              await convertRef.current(t.id);
              setBulkDone((n) => n + 1);
            } catch (err) {
              // One item's convert rejected — record it and keep going so the rest
              // still convert. Without this catch the loop would abort AND the
              // rejection would escape as an unhandled promise rejection.
              console.error(errorLabel, err);
              setBulkFailed((n) => n + 1);
            }
          }
        } finally {
          setBulkConverting(false);
          convertAllInFlight.current = false;
        }
      })();
    },
    [errorLabel],
  );

  // Live announcement (aria-live region) — "Converting k/N" while in flight, then
  // a terminal "Converted N findings (M failed)" once it settles.
  const bulkStatusMessage = useMemo(() => {
    if (bulkConverting) return `Converting ${bulkDone + bulkFailed}/${bulkTotal}…`;
    if (bulkTotal === 0) return '';
    const ok = `Converted ${bulkDone} ${bulkDone === 1 ? 'finding' : 'findings'}`;
    return bulkFailed > 0 ? `${ok} (${bulkFailed} failed).` : `${ok}.`;
  }, [bulkConverting, bulkDone, bulkFailed, bulkTotal]);

  // Inline (visible) failure summary surfaced in the results toolbar when one or
  // more conversions rejected mid-loop.
  const bulkError = useMemo(() => {
    if (bulkConverting || bulkFailed === 0) return null;
    return `${bulkFailed} of ${bulkTotal} ${
      bulkTotal === 1 ? 'finding' : 'findings'
    } could not be converted.`;
  }, [bulkConverting, bulkFailed, bulkTotal]);

  return {
    bulkConverting,
    bulkProgress: { done: bulkDone, total: bulkTotal, failed: bulkFailed },
    bulkStatusMessage,
    bulkError,
    resetBulk,
    convertAll,
  };
}
