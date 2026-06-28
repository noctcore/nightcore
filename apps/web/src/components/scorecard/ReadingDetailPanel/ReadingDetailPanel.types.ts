import type { ScorecardReadingView } from '../scorecard.types';

/** Props for the ReadingDetailPanel: the reading to show plus the close/harden/go-to-board handlers. */
export interface ReadingDetailPanelProps {
  reading: ScorecardReadingView;
  /** True while the harden action is in flight. */
  pending: boolean;
  onClose: () => void;
  /** Mint (or re-open) the hardening Build task for this dimension. */
  onHarden: (readingId: string) => void;
  /** Navigate to the board (used after a reading has been hardened). */
  onGotoBoard?: () => void;
}
