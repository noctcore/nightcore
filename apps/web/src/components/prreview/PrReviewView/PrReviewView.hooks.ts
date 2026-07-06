/** The permanent two-panel PR workspace resolved into a single view model. This
 *  hook is a thin composition of five focused concerns, each its own module:
 *    - the open-PR list           (`useOpenPrs`)
 *    - the per-PR run registry     (`usePrReviewRuns`)
 *    - the selected PR's section    (`usePrReviewSection` — registry projections
 *                                    + review-position layer)
 *    - the finding selection        (`usePrFindingSelection`)
 *    - the human-gated actions       (`usePrReviewGates`)
 *  plus the navigation actions (`usePrReviewNavigation`) that mutate the little
 *  navigation state owned here. The component shell renders purely from the
 *  returned {@link PrReviewViewModel}. */
import { useState } from 'react';

import { useToast } from '@/components/ui';
import { openExternal, type ReviewLens } from '@/lib/bridge';
import { useRunConfig } from '@/lib/useRunConfig';

import { ALL_LENSES } from '../prreview.constants';
import { usePrFixes } from '../prreview-fixes.hooks';
import { usePrReviewGates } from '../prreview-gates.hooks';
import { usePrReviewNavigation } from '../prreview-navigation.hooks';
import { useOpenPrs } from '../prreview-open-prs.hooks';
import { usePrReviewRuns } from '../prreview-runs.hooks';
import { buildReviewSectionProps } from '../prreview-section';
import { usePrReviewSection } from '../prreview-section.hooks';
import { usePrFindingSelection } from '../prreview-selection.hooks';
import type { PrStatusActions } from '../PrStatusBlock';
import type { PrReviewViewModel, PrReviewViewProps } from './PrReviewView.types';

export type { PrReviewViewModel } from './PrReviewView.types';

/** Resolve the entire PR workspace into a single view model: the persistent
 *  left list + the selected PR's registry-driven right panel. */
export function usePrReviewView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: PrReviewViewProps): PrReviewViewModel {
  const hasProject = projectPath !== null;
  const toast = useToast();
  const runs = usePrReviewRuns(hasProject);
  const fixes = usePrFixes(hasProject);
  const openPrs = useOpenPrs(hasProject);
  // The lens/model/effort form state — lives above the section so it survives
  // PR switches and prefills on "New review".
  const config = useRunConfig<ReviewLens>(ALL_LENSES, !hasProject);

  // --- Navigation state (owned here; the section projects against it, the
  //     navigation actions mutate it) -------------------------------------
  const [selectedPr, setSelectedPr] = useState<number | null>(null);
  /** A history selection: display THIS run instead of the PR's latest. */
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  /** "New review" over existing results: show config without dropping them. */
  const [reconfiguring, setReconfiguring] = useState(false);
  /** PRs inside the Review-click → optimistic-entry IPC gap (per-PR spinner). */
  const [startingPrs, setStartingPrs] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  // Project-switch reset, synchronously before paint (the render-adjust
  // pattern): the navigation belongs to the previous project's PR numbers. The
  // finding selection and the human gates reset themselves the same way.
  const [lastProject, setLastProject] = useState(projectPath);
  if (lastProject !== projectPath) {
    setLastProject(projectPath);
    setSelectedPr(null);
    setViewingRunId(null);
    setReconfiguring(false);
  }

  // --- The concern hooks, threaded in dependency order --------------------
  const section = usePrReviewSection({
    selectedPr,
    viewingRunId,
    reconfiguring,
    startingPrs,
    runs,
    fixes,
    openPrs,
    config,
  });
  const selection = usePrFindingSelection({
    projectPath,
    displayRunId: section.displayRunId,
    displayStream: section.displayStream,
    selectRun: runs.selectRun,
    refreshRuns: runs.refreshRuns,
  });
  const gates = usePrReviewGates({
    projectPath,
    postPrNumber: section.postPrNumber,
    addressPrNumber: section.addressPrNumber,
    selectedPr,
    displayRunId: section.displayRunId,
    selectedFindings: selection.selectedFindings,
    selectedOpenFindings: selection.selectedOpenFindings,
    selectRun: runs.selectRun,
    refreshRuns: runs.refreshRuns,
    fixes,
    clearSelection: selection.clearSelection,
  });
  const navigation = usePrReviewNavigation({
    selectedPr,
    setSelectedPr,
    setViewingRunId,
    setReconfiguring,
    setStartingPrs,
    runs,
    config,
    displayStream: section.displayStream,
    runningRunId: section.runningRunId,
    prHistory: section.prView?.history ?? [],
    resetFindingUi: selection.resetFindingUi,
    setSelectedId: selection.setSelectedId,
    closeGates: gates.closeAll,
    preselect,
    onPreselectConsumed,
  });

  // --- Cross-slice derived values (need both the section + the selection/gates) --
  const addressCount = selection.selectedOpenFindings.length;
  const canPost =
    section.displayStream?.status === 'completed' &&
    section.displayStream.prNumber !== null &&
    selection.selectedCount > 0;
  // Own-PR is deliberately NOT guarded: fixing your own PR is the normal case.
  const canAddress =
    section.displayStream?.status === 'completed' &&
    section.displayRunId !== null &&
    addressCount > 0 &&
    !section.fixRunning;
  // The status block's remediation actions are inert while ANY fix activity is
  // live for this PR — a running/committing fix session, an armed action in
  // flight, or an address dispatch (the backend refuses those atomically; the
  // UI just says why up front).
  const fixBusy =
    (section.prFix !== null &&
      (section.prFix.status === 'running' ||
        section.prFix.status === 'committing')) ||
    gates.fixActionBusy ||
    gates.addressing;
  const statusActions: PrStatusActions | undefined =
    selectedPr === null
      ? undefined
      : {
          onFixCi: () => gates.armFixAction('ci'),
          onResolveConflicts: () => gates.armFixAction('conflicts'),
          fixBusy,
        };
  const pushArmedFix =
    gates.pushFixId !== null ? (fixes.fixes.get(gates.pushFixId) ?? null) : null;

  const review = buildReviewSectionProps({
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
  });

  return {
    hasProject,
    projectName,
    prs: openPrs.prs,
    prsLoading: openPrs.loading,
    prsLoadingMore: openPrs.loadingMore,
    prsHasMore: openPrs.hasMore,
    prsError: openPrs.error,
    refreshPrs: openPrs.refresh,
    loadMorePrs: openPrs.loadMore,
    selectedPr,
    selectPr: navigation.selectPr,
    runningPrs: section.runningPrs,
    prRowStatuses: section.prRowStatuses,
    prFindingCounts: section.prFindingCounts,
    selectedSummary: section.selectedSummary,
    lifecycle: section.lifecycle,
    statusView: section.statusView,
    onOpenExternal: (url: string) =>
      void openExternal(url).catch((err: unknown) => {
        console.error('open_external failed', err);
        toast.error('Could not open the pull request', err);
      }),
    review,
    selected: selection.selected,
    closeFinding: () => selection.setSelectedId(null),
    pending: selection.pending,
    onConvert: selection.onConvert,
    onDismiss: selection.onDismiss,
    onRestore: selection.onRestore,
    onGotoBoard,
    postVerdict: gates.postVerdict,
    posting: gates.posting,
    postError: gates.postError,
    postPrNumber: section.postPrNumber,
    selectedCount: selection.selectedCount,
    selectedInlineCount: selection.selectedInlineCount,
    confirmPost: gates.confirmPost,
    cancelPost: gates.cancelPost,
    addressArmed: gates.addressArmed,
    addressing: gates.addressing,
    addressError: section.addressError,
    addressPrNumber: section.addressPrNumber,
    addressCount,
    confirmAddress: gates.confirmAddress,
    cancelAddress: gates.cancelAddress,
    pushArmedFix,
    pushing: gates.pushing,
    pushError: gates.pushError,
    pushPostComment: gates.pushPostComment,
    setPushPostComment: gates.setPushPostComment,
    confirmPush: gates.confirmPush,
    cancelPush: gates.cancelPush,
    fixActionArmed: gates.fixActionArmed,
    fixActionBusy: gates.fixActionBusy,
    fixActionError: section.addressError,
    confirmFixAction: gates.confirmFixAction,
    cancelFixAction: gates.cancelFixAction,
    statusActions,
  };
}
