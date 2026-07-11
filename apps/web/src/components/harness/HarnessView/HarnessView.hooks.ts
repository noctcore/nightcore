/** The Harness surface resolved into a single view model. This hook is a thin
 *  composition of focused concerns, each its own feature-root module:
 *    - the data layer         (`useHarness`)
 *    - the shared results view  (`useScanResultsView` — tab / selection / peek)
 *    - the proposals concern     (`useHarnessProposals`)
 *    - the artifacts + apply/arm  (`useHarnessApply`)
 *  plus the CONFIGURE run config, the convention-grid derivations, and the
 *  preselect provenance wiring. The component shell renders purely from the
 *  returned {@link HarnessViewModel}. */
import { useCallback, useMemo, useState } from 'react';

import type { MenuItem, RunPhase, RunProgressCategory } from '@/components/ui';
import { useToast } from '@/components/ui';
import type { ConventionCategory, CoverageStatus } from '@/lib/bridge';
import { formatRunReceipt } from '@/lib/formatters';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@/lib/models';
import {
  buildLensTabs,
  countByLens,
  countOpenItems,
  deriveRunPhase,
  scanSkeletonCount,
} from '@/lib/scan-run';
import { sortBySeverityThenStatus } from '@/lib/severity';
import { useBulkConvert } from '@/lib/useBulkConvert';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import { useScanResultsView } from '@/lib/useScanResultsView';
import { useScanRun } from '@/lib/useScanRun';

import type { CategoryTab } from '../CategoryTabs';
import { ALL_CATEGORIES, CATEGORY_META } from '../harness.constants';
import type { ConventionFindingVM } from '../harness.types';
import { useHarnessApply } from '../harness-apply.hooks';
import { harnessScanConfig, useHarness } from '../harness-data.hooks';
import { useHarnessProposals } from '../harness-proposals.hooks';
import {
  defaultSectionForMode,
  sectionTabsForMode,
  showProfileBannerForMode,
} from '../harness-sections';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type {
  HarnessSection,
  HarnessViewModel,
  HarnessViewProps,
} from './HarnessView.types';

export type { HarnessSection, HarnessViewModel } from './HarnessView.types';

/** Resolve the entire Harness surface into a single view model: the live/persisted
 *  stream (via `useHarness`), the section/tab + selected finding/artifact UI state,
 *  the apply-confirm flow, and every derived list. */
export function useHarnessView({
  projectPath,
  projectName,
  mode,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: HarnessViewProps): HarnessViewModel {
  const hasProject = projectPath !== null;
  // The shared scan run-lifecycle (see scan-family-parity): the `useScanRun` call
  // lives here in the view-hooks file; `useHarness` layers the launch + item
  // lifecycle actions over the resulting run API.
  const scan = useScanRun(harnessScanConfig());
  const harness = useHarness(scan, hasProject);
  const { stream } = harness;

  const toast = useToast();
  // The shared results-view cluster: tab / finding selection / pending+runAction /
  // reconfigure / peek. Harness's extra selections (proposal / artifact) and the
  // apply/arm confirm flows live in their own family-side hooks below.
  const view = useScanResultsView<ConventionCategory>({
    notifyError: (title, err) => toast.error(title, err),
  });
  const { activeTab, resetTransient, runAction, startReconfigure } = view;
  // Default section is destination-driven: harden opens on Proposals, enforce on
  // Conventions, the unified route on Conventions (its pre-split default).
  const [section, setSection] = useState<HarnessSection>(defaultSectionForMode(mode));

  // Lifted CONFIGURE run config (the shared shape Insight uses too). It lives here
  // (not in RunControls) so the config survives the CONFIGURE → RUNNING → RESULTS
  // phase swaps and pre-fills on a new run. `view.reconfiguring` is the explicit
  // "New run" override that returns RESULTS to CONFIGURE without discarding the run.
  const config = useRunConfig(!hasProject);

  const proposals = useHarnessProposals({ stream, harness, runAction, toast });
  const apply = useHarnessApply({ stream, harness, runAction, toast });

  // Bulk convert-all for the ENFORCE conventions grid (the shared Insight idiom):
  // "convert every open convention → tasks" over the per-finding convert seam. Its
  // sibling — the Harden proposals convert-all — lives in `useHarnessProposals`.
  const {
    resetBulk: resetConventionsBulk,
    convertAll: convertAllConventions,
    bulkConverting: conventionsBulkConverting,
    bulkProgress: conventionsBulkProgress,
    bulkStatusMessage: conventionsBulkStatusMessage,
    bulkError: conventionsBulkError,
  } = useBulkConvert(harness.convertFinding, 'convertHarnessFindingToTask failed');

  const openConventions = useMemo(
    () => stream.findings.filter((f) => f.status === 'open'),
    [stream.findings],
  );

  // Reset the results transient state AND both convert-all machines together, so a
  // prior run's "Converted k/N" summaries can't bleed into a freshly entered run.
  const resetRunTransient = useCallback(() => {
    resetTransient();
    resetConventionsBulk();
    proposals.resetProposalsBulk();
  }, [resetTransient, resetConventionsBulk, proposals.resetProposalsBulk]);

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + item to open. Consume the target FIRST, land on that run's RESULTS in
  // the owning section, and open the item's detail panel — a convention finding or
  // a proposal, per the token's `kind`.
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: harness.selectRun,
    onEnter: resetRunTransient,
    onOpenItem: ({ itemId, kind }) => {
      if (kind === 'proposal') {
        setSection('proposals');
        proposals.openProposalById(itemId);
      } else {
        setSection('conventions');
        view.setActiveTab('all');
        view.setSelectedId(itemId);
      }
    },
  });

  const phase: RunPhase = deriveRunPhase(stream.status, harness.isStarting, view.reconfiguring);

  // "New run": pre-fill the form from the last run's model + lenses, then drop back
  // to CONFIGURE. (Effort isn't persisted on a run, so the lifted value carries.)
  // prefill resets the model even to null (a default-model rerun), so the form
  // never keeps a stale model — mirrors Insight.
  const reconfigure = useCallback(() => {
    config.prefill({
      model: stream.model,
      categories: stream.requestedCategories,
    });
    startReconfigure();
  }, [config, stream.model, stream.requestedCategories, startReconfigure]);

  const onScan = useCallback(() => {
    resetRunTransient();
    void harness.start(config.orderedSelected, config.model, config.effort, config.providerId);
  }, [harness, config, resetRunTransient]);

  const summary = useMemo(() => {
    const modelLabel =
      MODEL_OPTIONS.find((o) => o.id === stream.model)?.label ??
      stream.model ??
      'Default model';
    const effortLabel =
      EFFORT_OPTIONS.find((o) => o.id === config.effort)?.label ?? null;
    const n = stream.requestedCategories.length;
    return `⌖ ${modelLabel}${effortLabel !== null ? ` · ${effortLabel}` : ''} · ${n} ${
      n === 1 ? 'lens' : 'lenses'
    }`;
  }, [stream.model, stream.requestedCategories.length, config.effort]);

  const progressCategories: RunProgressCategory[] = useMemo(
    () =>
      stream.requestedCategories.map((c) => ({
        key: c,
        label: CATEGORY_META[c].label,
        icon: CATEGORY_META[c].icon,
      })),
    [stream.requestedCategories],
  );

  const findingCounts = useMemo(
    () => countByLens(stream.findings, (f) => f.category),
    [stream.findings],
  );

  const peekFindings = useMemo(
    () =>
      view.peekLens === null
        ? []
        : sortBySeverityThenStatus(
            stream.findings.filter((f) => f.category === view.peekLens),
          ),
    [view.peekLens, stream.findings],
  );

  const tabs: CategoryTab[] = useMemo(
    () =>
      buildLensTabs({
        all: ALL_CATEGORIES,
        requested: stream.requestedCategories,
        stepState: stream.categoryState,
        items: stream.findings,
        lensOf: (f) => f.category,
      }),
    [stream.requestedCategories, stream.categoryState, stream.findings],
  );

  const gridFindings = useMemo(() => {
    const filtered =
      activeTab === 'all'
        ? stream.findings
        : stream.findings.filter((f) => f.category === activeTab);
    return sortBySeverityThenStatus(filtered);
  }, [stream.findings, activeTab]);

  const skeletonCount = useMemo(
    () => scanSkeletonCount(stream.status, stream.categoryState, activeTab),
    [stream.status, stream.categoryState, activeTab],
  );

  const selectedFinding = useMemo(
    () => stream.findings.find((f) => f.id === view.selectedId) ?? null,
    [stream.findings, view.selectedId],
  );

  const emptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run a scan to surface the conventions across your codebase.';
    }
    if (stream.status === 'running') return 'Scanning…';
    if (stream.status === 'failed') {
      return `Scan failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No conventions in this lens.';
  }, [stream.status, stream.error]);

  const runHistory: MenuItem[] = useMemo(
    () =>
      harness.runs.map((run) => ({
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} conventions · ${formatRunReceipt(run.costUsd, run.durationMs)}`,
        onClick: () => {
          // Selecting a past run lands on its RESULTS — drop any reconfigure/peek.
          resetRunTransient();
          void harness.selectRun(run.id);
        },
      })),
    [harness, resetRunTransient],
  );

  // The section toggle is a pure filter over the ONE run's findings/proposals/
  // artifacts: `mode` picks which tabs render (harden → propose half, enforce →
  // enforce half, undefined → all), each carrying its live badge count.
  const sectionTabs = useMemo(
    () =>
      sectionTabsForMode(mode, {
        conventions: countOpenItems(stream.findings),
        proposals: proposals.proposalsBulk.count,
        artifacts: apply.artifactCount,
      }),
    [mode, stream.findings, proposals.proposalsBulk.count, apply.artifactCount],
  );

  // ENFORCE-lite coverage: the per-convention `enforced/documented-only/unenforced`
  // status, keyed by `fingerprint` so the ConventionGrid can badge each row. Only the
  // Enforce destination surfaces it (the badge + the RuleCoverageGaps panel).
  const showCoverage = mode === 'enforce';
  const coverageByFingerprint = useMemo(() => {
    const map: Record<string, CoverageStatus> = {};
    for (const gap of stream.coverage) {
      map[gap.conventionFingerprint] = gap.status;
    }
    return map;
  }, [stream.coverage]);

  return {
    hasProject,
    projectName,
    stream,
    isStarting: harness.isStarting,
    startError: harness.startError,
    phase,
    summary,
    reconfigure,
    config,
    progressCategories,
    categoryRunState: stream.categoryState,
    findingCounts,
    synthesizing: stream.synthesizing,
    peekCategory: view.peekLens,
    peekLabel: view.peekLens === null ? null : CATEGORY_META[view.peekLens].label,
    peekFindings,
    openCategory: (key: string) => view.openPeek(key as ConventionCategory),
    clearPeek: view.clearPeek,
    runHistory,
    hasHistory: harness.runs.length > 0,
    profileLoading: stream.status === 'running' && stream.profile === null,
    showProfileBanner: showProfileBannerForMode(mode),
    section,
    setSection,
    sectionTabs,
    tabs,
    activeTab,
    setActiveTab: view.setActiveTab,
    gridFindings,
    skeletonCount,
    emptyMessage,
    coverage: stream.coverage,
    coverageByFingerprint,
    showCoverage,
    proposals: proposals.proposals,
    proposalsLoading: proposals.proposalsLoading,
    proposalsEmptyMessage: proposals.proposalsEmptyMessage,
    artifacts: apply.artifacts,
    artifactsLoading: apply.artifactsLoading,
    artifactsEmptyMessage: apply.artifactsEmptyMessage,
    selectedFinding,
    openFinding: (finding: ConventionFindingVM) => view.setSelectedId(finding.id),
    closeFinding: () => view.setSelectedId(null),
    selectedProposal: proposals.selectedProposal,
    openProposal: proposals.openProposal,
    closeProposal: proposals.closeProposal,
    // The two convert-all bar slices (shared Insight idiom). Grouped as cohesive
    // sub-objects — spread straight into <BulkConvertBar> — so the view model's
    // budgeted return surface (issue #53) stays under cap.
    conventionsBulk: {
      count: openConventions.length,
      converting: conventionsBulkConverting,
      progress: conventionsBulkProgress,
      statusMessage: conventionsBulkStatusMessage,
      error: conventionsBulkError,
      onConvertAll: () => convertAllConventions(openConventions),
    },
    proposalsBulk: proposals.proposalsBulk,
    selectedArtifact: apply.selectedArtifact,
    openArtifact: apply.openArtifact,
    closeArtifact: apply.closeArtifact,
    pending: view.pending,
    applyTarget: apply.applyTarget,
    applying: apply.applying,
    applyError: apply.applyError,
    onScan,
    onCancel: () => void harness.cancel(),
    onConvertFinding: (id) => void runAction('convert convention', () => harness.convertFinding(id)),
    onDismissFinding: (id) => void runAction('dismiss convention', () => harness.dismissFinding(id)),
    onRestoreFinding: (id) => void runAction('restore convention', () => harness.restoreFinding(id)),
    onConvertProposal: proposals.onConvertProposal,
    onApplyProposal: proposals.onApplyProposal,
    onDismissProposal: proposals.onDismissProposal,
    onRestoreProposal: proposals.onRestoreProposal,
    applyProposalTarget: proposals.applyProposalTarget,
    applyProposalPaths: proposals.applyProposalPaths,
    confirmApplyProposal: proposals.confirmApplyProposal,
    cancelApplyProposal: proposals.cancelApplyProposal,
    onGotoBoard,
    onDismissArtifact: apply.onDismissArtifact,
    onRestoreArtifact: apply.onRestoreArtifact,
    requestApply: apply.requestApply,
    confirmApply: apply.confirmApply,
    cancelApply: apply.cancelApply,
    armTarget: apply.armTarget,
    armCommand: apply.armCommand,
    requestArm: apply.requestArm,
    confirmArm: apply.confirmArm,
    cancelArm: apply.cancelArm,
  };
}
