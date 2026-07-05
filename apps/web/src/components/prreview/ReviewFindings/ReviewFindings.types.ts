/** Props for the ReviewFindings results grid. */
import type { ReviewFindingView } from '../prreview.types';

/** Props for the ReviewFindings grid: the findings to render (grouped by severity),
 *  the empty message, and the selection + open handlers. The grid renders only in
 *  the section's RESULTS mode, so it carries no streaming-skeleton wiring. */
export interface ReviewFindingsProps {
  /** The findings to render as cards, grouped into severity sections. */
  findings: ReviewFindingView[];
  /** Shown when there are no findings. */
  emptyMessage: string;
  /** How to render the no-findings state: `clean` gives a celebratory positive
   *  empty state (a completed run that surfaced nothing), `neutral` the plain
   *  message (idle / failed / cancelled). Defaults to `neutral`. */
  emptyVariant?: 'clean' | 'neutral';
  /** The set of finding ids selected for the posted review. */
  selection: ReadonlySet<string>;
  /** Toggle a single finding in/out of the selection (a card checkbox). */
  onToggleSelect: (findingId: string) => void;
  /** Replace the whole selection — the quick-select presets and per-group
   *  tri-state toggles compose the next set (over OPEN findings only) and hand
   *  it up here; the view model stores it. */
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /** Open a finding's detail panel. */
  onOpen: (finding: ReviewFindingView) => void;
  /** Fingerprints that also surfaced in the PREVIOUS run (the follow-up
   *  comparison) — matching cards get a subtle "still open" chip. Absent/empty
   *  on a first review or a non-latest history selection. */
  recurringFingerprints?: ReadonlySet<string>;
}
