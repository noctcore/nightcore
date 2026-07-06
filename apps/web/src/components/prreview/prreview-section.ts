/**
 * Pure assembly of the `ReviewSectionProps` from the composed workspace hooks:
 * the section projections, the finding selection, the human gates, and the
 * navigation actions. No React, no bridge calls — it just wires the already-
 * resolved slices into the controlled shape the {@link ReviewSection} renders.
 */
import type { ToastApi } from '@/components/ui';
import type { ReviewLens } from '@/lib/bridge';
import type { RunConfig } from '@/lib/useRunConfig';

import type { UsePrFixesResult } from './prreview-fixes.hooks';
import type { PrReviewGatesApi } from './prreview-gates.hooks';
import type { PrReviewNavigationApi } from './prreview-navigation.hooks';
import type { PrReviewSectionApi } from './prreview-section.hooks';
import type { PrFindingSelectionApi } from './prreview-selection.hooks';
import type { ReviewSectionProps } from './ReviewSection';

/** The composed slices the review-section assembly reads from. */
export interface BuildReviewSectionArgs {
  selectedPr: number | null;
  /** "New review" over existing results (whether the config back-link shows). */
  reconfiguring: boolean;
  config: RunConfig<ReviewLens>;
  section: PrReviewSectionApi;
  selection: PrFindingSelectionApi;
  gates: PrReviewGatesApi;
  navigation: PrReviewNavigationApi;
  fixes: UsePrFixesResult;
  toast: ToastApi;
  /** Whether the post-review toolbar is actionable (completed + ≥1 selected). */
  canPost: boolean;
  /** Whether Address-findings is actionable (K > 0 and no fix running). */
  canAddress: boolean;
  /** Selected OPEN findings count — the K in "Address findings (K)". */
  addressCount: number;
}

/** Assemble the review-section props, or null when nothing is selected. */
export function buildReviewSectionProps({
  selectedPr,
  reconfiguring,
  config,
  section,
  selection,
  gates,
  navigation,
  fixes,
  toast,
  canPost,
  canAddress,
  addressCount,
}: BuildReviewSectionArgs): ReviewSectionProps | null {
  if (selectedPr === null) return null;
  // Capture the narrowable locals so the fix-strip closures keep prFix non-null.
  const { displayStream, displayRun, prFix } = section;
  const openFindings = (displayStream?.findings ?? []).filter(
    (f) => f.status === 'open',
  );

  return {
    prNumber: selectedPr,
    mode: section.mode,
    stream: section.mode === 'running' ? section.runningStream : displayStream,
    configure: {
      config,
      isStarting: section.isStarting,
      startError: section.startError,
      onReview: navigation.onReview,
      onBackToResults:
        reconfiguring && displayStream !== null ? navigation.backToResults : null,
    },
    running: {
      categories: section.progressCategories,
      findingCounts: section.lensFindingCounts,
      onCancel: navigation.onCancelRun,
    },
    results: {
      gridFindings: selection.gridFindings,
      emptyMessage: section.emptyMessage,
      // A completed run with nothing to show earns the celebratory clean
      // state; idle / failed / cancelled keep the neutral message.
      emptyVariant: displayStream?.status === 'completed' ? 'clean' : 'neutral',
      selection: selection.selection,
      onToggleSelect: selection.onToggleSelect,
      onSelectionChange: selection.onSelectionChange,
      onOpenFinding: (finding) => selection.setSelectedId(finding.id),
      onNewReview: navigation.startNewReview,
      toolbar: {
        openCount: openFindings.length,
        onConvertAll: () => selection.convertAll(openFindings),
        bulkConverting: selection.bulkConverting,
        bulkProgress: selection.bulkProgress,
        bulkStatusMessage: selection.bulkStatusMessage,
        bulkError: selection.bulkError,
        selectedCount: selection.selectedCount,
        canPost,
        requestPost: gates.requestPost,
        ownPr: section.ownPr,
        postedFeedback: gates.postedFeedback,
        addressCount,
        canAddress,
        fixRunning: section.fixRunning,
        requestAddress: gates.requestAddress,
        addressError: section.addressError,
      },
      // The PR's fix strip: plain closures over `prFix` (fresh per render; the
      // card is inert chrome, so memoizing buys nothing). The push button ARMS
      // the gate — the actual push lives behind confirmPush.
      fix:
        prFix === null
          ? null
          : {
              fix: prFix,
              pushing: gates.pushing && gates.pushFixId === prFix.id,
              onCancel: () => {
                void fixes.cancel(prFix.id).catch((err: unknown) => {
                  console.error('cancel_pr_fix failed', err);
                  toast.error('Could not cancel the fix', err);
                });
              },
              onRequestPush: () => gates.requestPush(prFix.id),
              // Fresh review of the same PR with the last config (the lifted
              // RunConfig survives runs and PR switches).
              onReReview: navigation.onReview,
              onDismiss: () => fixes.dismiss(prFix.id),
            },
      timeline: section.timeline,
      // The review-position layer for the displayed run (ReviewPosition
      // self-hides when empty — a running/failed run carries no verdict, no
      // reconciliation, no follow-up).
      position: {
        verdict: displayRun?.verdict ?? null,
        verdictReasoning: displayRun?.verdictReasoning ?? null,
        reconciliation: section.reconciliation,
        stale: section.stale,
        followup: section.followup,
        onReReview: navigation.onReview,
      },
    },
    history: {
      items: navigation.historyItems,
      viewingPastRun: section.viewingPastRun,
      onBackToLatest: navigation.backToLatest,
    },
  };
}
