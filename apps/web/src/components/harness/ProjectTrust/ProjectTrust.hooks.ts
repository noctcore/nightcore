/** Data ownership for the Project trust dashboard: read the computed summary,
 *  refresh it on demand, and export the shields badge.
 *
 *  There is nothing to cache here on purpose. The summary is COMPUTED per call
 *  from the task store, the flight-recorder ledgers and the append-only governance
 *  journal, so holding a stale copy across a policy save would let the dashboard
 *  disagree with the journal it summarizes — the exact drift the journal exists to
 *  prevent. Every mutation path that could change it (a save, an arm, a
 *  quarantine) is followed by a refresh from the owner. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  exportGovernanceBadge,
  type ProjectTrustSummary,
  projectTrustSummary,
} from '@/lib/bridge';

/** Everything the ProjectTrust card's owner passes down. */
export interface ProjectTrustVM {
  /** `null` until the first read returns, then the computed summary. */
  summary: ProjectTrustSummary | null;
  loading: boolean;
  exporting: boolean;
  refresh: () => void;
  exportBadge: () => void;
}

/**
 * Own the project trust summary.
 *
 * FAIL-QUIET on read, LOUD on export. A failed read never becomes an error
 * banner: the dashboard is evidence ABOUT the gates, not a gate, and the
 * authoring surface must stay usable when a ledger is missing or unreadable (the
 * recorder's own posture). A failed EXPORT is surfaced — the user asked for a
 * file and must not believe one was written. Reads are single-flighted so a slow
 * disk cannot stack up refreshes.
 */
export function useProjectTrust(): ProjectTrustVM {
  const [summary, setSummary] = useState<ProjectTrustSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const inFlight = useRef(false);
  const toast = useToast();

  const read = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setSummary(await projectTrustSummary());
    } catch {
      // Keep whatever we already showed; the card leaves its skeleton only once
      // a read settles, so a first-read failure must not spin forever.
      setSummary((prev) => prev);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const exportBadge = useCallback(() => {
    setExporting(true);
    void (async () => {
      try {
        const result = await exportGovernanceBadge();
        if (result.saved) {
          toast.push({
            tone: 'success',
            title: 'Badge exported',
            description: `Point a shields endpoint badge at ${result.path}.`,
          });
        }
      } catch (err) {
        toast.error('Could not export the governance badge', err);
      } finally {
        setExporting(false);
      }
    })();
  }, [toast]);

  return {
    summary,
    loading,
    exporting,
    refresh: useCallback(() => void read(), [read]),
    exportBadge,
  };
}
