import type { PrFixState, PrSummary } from '@/lib/bridge';
import type { ScanTarget } from '@/lib/source-ref';

import type { ReviewFindingView, ReviewVerdict } from '../prreview.types';
import type { ReviewLifecycle } from '../prreview-lifecycle';
import type { PrStatusActions } from '../PrStatusBlock';
import type { PrNumberStatusView } from '../PrStatusBlock/PrStatusBlock.hooks';
import type { ReviewSectionProps } from '../ReviewSection';

/** Props for the top-level PrReviewView component. Identical to InsightViewProps. */
export interface PrReviewViewProps {
  /** The active project's absolute path (null when no project is active). */
  projectPath: string | null;
  /** The active project's display name. */
  projectName: string | null;
  /** Navigate to the board (used after convert-to-task). */
  onGotoBoard?: () => void;
  /** A board→scan provenance target: the run + finding to load and open on
   *  mount (a task's `sourceRef` chip navigated here). Consumed once. */
  preselect?: ScanTarget | null;
  /** Acknowledge the preselect so routing clears it (it never refires). */
  onPreselectConsumed?: () => void;
}

/** Everything the two-panel PrReviewView shell renders. `hasProject === false`
 *  is the only early-return branch; every other field is meaningful. */
export interface PrReviewViewModel {
  hasProject: boolean;
  projectName: string | null;
  // --- Left rail (persistent PR list) ---
  prs: PrSummary[];
  prsLoading: boolean;
  /** True while a "load more" doubled-cap refetch is in flight (rows stay up). */
  prsLoadingMore: boolean;
  /** Whether more PRs may exist beyond the current fetch cap. */
  prsHasMore: boolean;
  prsError: string | null;
  /** Re-fetch the open-PR list (the header Refresh-PRs action). */
  refreshPrs: () => void;
  /** Grow the PR-list cap and refetch (the picker's "Load more" footer). */
  loadMorePrs: () => void;
  /** The selected PR number, or null (empty right panel). */
  selectedPr: number | null;
  /** Select a PR. NEVER cancels anything — runs keep streaming in the registry. */
  selectPr: (prNumber: number | null) => void;
  /** Distinct PR numbers with a run in flight across the WHOLE registry (a
   *  concurrent-run signal — includes runs whose PR isn't in the open list). */
  runningPrs: readonly number[];
  /** Per-PR review lifecycle for the listed PRs (list-row status dot + label). */
  prRowStatuses: Readonly<Record<number, ReviewLifecycle>>;
  /** Open-finding count of each listed PR's latest completed run. */
  prFindingCounts: Readonly<Record<number, number>>;
  // --- Right panel (the selected PR's workspace) ---
  /** The selected PR's open-list summary, or null for a typed number. */
  selectedSummary: PrSummary | null;
  /** The selected PR's derived review lifecycle (workspace status line), or null
   *  when nothing is selected. */
  lifecycle: ReviewLifecycle | null;
  /** The lifted live-status view for the selected PR (passed to the workspace so
   *  the status block doesn't self-fetch). */
  statusView: PrNumberStatusView;
  /** Open a PR page in the system browser (backend-validated https-only). */
  onOpenExternal: (url: string) => void;
  /** The fully-assembled review-section props, or null when nothing is selected. */
  review: ReviewSectionProps | null;
  // --- Finding detail overlay ---
  /** The finding open in the detail panel, or `null`. */
  selected: ReviewFindingView | null;
  closeFinding: () => void;
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onGotoBoard?: () => void;
  // --- Post-review human gate ---
  /** The verdict whose ConfirmDialog is open, or `null`. */
  postVerdict: ReviewVerdict | null;
  posting: boolean;
  postError: string | null;
  /** The PR the armed post targets (the displayed run's PR). */
  postPrNumber: number | null;
  selectedCount: number;
  /** How many selected findings carry a line anchor (become inline comments). */
  selectedInlineCount: number;
  /** Confirm + await the post (composes body + comments from the selection). */
  confirmPost: () => void;
  /** Cancel the gate. A no-op while a post is in flight. */
  cancelPost: () => void;
  // --- Address-findings human gate (start a fix agent on the PR branch) ---
  /** True when the address ConfirmDialog is open. */
  addressArmed: boolean;
  /** True while the armed address is in flight (checkout + dispatch). */
  addressing: boolean;
  /** This PR's last address rejection (also shown in the toolbar), or null. */
  addressError: string | null;
  /** The PR the armed address targets (the displayed run's PR). */
  addressPrNumber: number | null;
  /** Selected OPEN findings count — the K the fix prompt will carry. */
  addressCount: number;
  /** Confirm + await the address (starts the paid fix session). */
  confirmAddress: () => void;
  /** Cancel the gate. A no-op while an address is in flight. */
  cancelAddress: () => void;
  // --- Push-fix human gate (THE external side effect of the fix arc) ---
  /** The fix the armed push targets (dialog open when non-null). */
  pushArmedFix: PrFixState | null;
  pushing: boolean;
  pushError: string | null;
  /** Whether the push also posts the summary comment on the PR (the push
   *  dialog's checkbox — sticky across pushes, default on). */
  pushPostComment: boolean;
  setPushPostComment: (next: boolean) => void;
  /** Confirm + await the push (plain push, never force). */
  confirmPush: () => void;
  /** Cancel the gate. A no-op while a push is in flight. */
  cancelPush: () => void;
  // --- Status-block remediation gates (Fix CI / Resolve conflicts) ---
  /** Which remediation ConfirmDialog is armed, or null (closed). */
  fixActionArmed: 'ci' | 'conflicts' | null;
  /** True while the armed action is in flight (checks read / merge / dispatch). */
  fixActionBusy: boolean;
  /** This PR's last fix-start rejection — rendered inline in the armed dialog
   *  (the shared per-PR fix-error slot, same as the address gate's). */
  fixActionError: string | null;
  /** Confirm + await the armed action (starts the paid fix session). */
  confirmFixAction: () => void;
  /** Cancel the gate. A no-op while the action is in flight. */
  cancelFixAction: () => void;
  /** The status block's remediation actions, threaded through the workspace
   *  (undefined when no PR is selected). */
  statusActions: PrStatusActions | undefined;
}
