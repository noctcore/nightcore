/** Types for the per-PR FIX status strip (running → awaiting_push → pushed, or
 *  failed), rendered inside the ReviewSection's results mode. Controlled and
 *  purely presentational — every piece of state (including both ConfirmDialog
 *  human gates) lives in the PrReviewView model. */
import type { PrFixState } from '@/lib/bridge';

/** Props for the {@link FixRunCard}. */
export interface FixRunCardProps {
  /** The PR's displayed fix (its latest snapshot by `updatedAt`). */
  fix: PrFixState;
  /** True while an armed push is in flight (disables Push to PR). */
  pushing: boolean;
  /** Cancel the running fix. */
  onCancel: () => void;
  /** Arm the push ConfirmDialog — the human gate lives in the view shell, so
   *  this never pushes directly. */
  onRequestPush: () => void;
  /** Start a fresh review of this PR with the last config. */
  onReReview: () => void;
  /** Hide a failed fix's card (local-only; the registry entry survives). */
  onDismiss: () => void;
  /** Re-arm the address human gate to retry a FAILED fix on the current
   *  selection (the ConfirmDialog reopens — never fires directly). Omitted where
   *  the retry path isn't wired (stories/tests) — the button then doesn't render. */
  onTryAgain?: () => void;
}
