/** Data + UI-state hooks for the Harness surface: `useHarness` drives the live/
 *  persisted run and lifecycle actions, `useHarnessView` resolves the full view model. */
import { useCallback, useMemo, useState } from 'react';

import type {
  CategoryRunState,
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import { useToast } from '@/components/ui';
import {
  applyHarnessArtifact,
  applyHarnessProposal,
  armHarnessGauntletCheck,
  cancelHarnessScan,
  type ConventionCategory,
  convertHarnessFindingToTask,
  convertHarnessProposal,
  dismissHarnessArtifact,
  dismissHarnessFinding,
  dismissHarnessProposal,
  type EffortLevel,
  getHarnessRun,
  type HarnessEvent,
  type HarnessRun,
  listHarnessRuns,
  onHarnessEvent,
  restoreHarnessArtifact,
  restoreHarnessFinding,
  restoreHarnessProposal,
  startHarnessScan,
  type Task,
} from '@/lib/bridge';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@/lib/models';
import { deriveRunPhase, seedStepState } from '@/lib/scan-run';
import { usePreselectNavigation } from '@/lib/usePreselectNavigation';
import type { RunConfig } from '@/lib/useRunConfig';
import { useScanRun } from '@/lib/useScanRun';

import type { CategoryTab } from '../CategoryTabs';
import { ALL_CATEGORIES, CATEGORY_META, severityRankValue } from '../harness.constants';
import type {
  ConventionFindingVM,
  HarnessProposalVM,
  ProposedArtifactVM,
} from '../harness.types';
import {
  type CategoryProgress,
  EMPTY_HARNESS_STREAM,
  foldHarness,
  type HarnessStream,
  streamFromRun,
} from '../harness-stream';
import { useRunConfig } from '../RunControls/RunControls.hooks';
import type { HarnessViewProps } from './HarnessView.types';

/** The data layer `useHarness` exposes: the current stream, run history, start
 *  state, and the scan + finding/artifact lifecycle actions. */
export interface UseHarnessResult {
  stream: HarnessStream;
  runs: HarnessRun[];
  isStarting: boolean;
  startError: string | null;
  start: (
    categories: ConventionCategory[],
    model: string | null,
    effort: string | null,
  ) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  dismissFinding: (findingId: string) => Promise<void>;
  restoreFinding: (findingId: string) => Promise<void>;
  /** Convert a convention finding into a board task (idempotent). Returns the task. */
  convertFinding: (findingId: string) => Promise<Task | null>;
  dismissProposal: (proposalId: string) => Promise<void>;
  restoreProposal: (proposalId: string) => Promise<void>;
  /** Convert a task-shaped proposal into a board task (idempotent). Returns the task. */
  convertProposal: (proposalId: string) => Promise<Task | null>;
  /** Apply an `apply-artifacts` proposal as a bundle (writes every artifact to disk).
   *  Resolves on success; REJECTS with the write error (surfaced inline). */
  applyProposal: (proposalId: string) => Promise<void>;
  dismissArtifact: (artifactId: string) => Promise<void>;
  restoreArtifact: (artifactId: string) => Promise<void>;
  /** Apply an artifact to disk. Resolves on success; REJECTS with the write error
   *  (surfaced inline by the confirm dialog) so a refused overwrite isn't swallowed. */
  applyArtifact: (artifactId: string) => Promise<void>;
  /** Arm a Structure-Lock check into the project's `.nightcore/harness.json` so the
   *  gauntlet enforces it on every future task. Command is user-confirmed, not derived. */
  armCheck: (name: string, kind: string, command: string) => Promise<void>;
}

/** Drive the Harness data layer: live `harness-*` fold for the active run,
 *  authoritative reconciliation against the persisted run on completion, and the
 *  finding/artifact lifecycle actions. */
export function useHarness(hasProject: boolean): UseHarnessResult {
  const scan = useScanRun<HarnessEvent, HarnessRun, HarnessStream>({
    emptyStream: EMPTY_HARNESS_STREAM,
    listRuns: listHarnessRuns,
    getRun: getHarnessRun,
    streamFromRun,
    cancelRun: cancelHarnessScan,
    subscribe: onHarnessEvent,
    // The persisted run drops the failure `reason`, so keep the live fold's reason
    // for the same run — otherwise reconciling a user cancel reverts the neutral
    // "cancelled" notice straight back to a red failure banner.
    reconcileStream: (run, prev) => ({
      ...streamFromRun(run),
      failureReason: prev.runId === run.id ? prev.failureReason : null,
    }),
    onEvent: (event, { activeRunId, setStream, refreshRuns, reconcile }) => {
      if (event.type === 'artifact-applied') {
        setStream((prev) =>
          prev.runId === event.runId
            ? {
                ...prev,
                artifacts: prev.artifacts.map((a) =>
                  a.id === event.artifactId
                    ? { ...a, status: 'applied', appliedPath: event.path }
                    : a,
                ),
              }
            : prev,
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'finding-converted') {
        // Matches on stream.runId (NOT the activeRunId gate below) so a convert against
        // a displayed-but-not-live run still updates in place — mirrors Insight.
        setStream((prev) =>
          prev.runId === event.runId
            ? {
                ...prev,
                findings: prev.findings.map((f) =>
                  f.id === event.findingId
                    ? { ...f, status: 'converted', linkedTaskId: event.taskId }
                    : f,
                ),
              }
            : prev,
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'proposal-converted') {
        // Matches on stream.runId (like finding-converted) so a convert against a
        // displayed-but-not-live run still updates in place.
        setStream((prev) =>
          prev.runId === event.runId
            ? {
                ...prev,
                proposals: prev.proposals.map((p) =>
                  p.id === event.proposalId
                    ? { ...p, status: 'converted', linkedTaskId: event.taskId }
                    : p,
                ),
              }
            : prev,
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'proposal-applied') {
        // The bundle's per-artifact writes each emit their own `artifact-applied`
        // notice (which flips the artifact rows); this one flips the PROPOSAL to
        // applied. Matches on stream.runId so a displayed-but-not-live run updates too.
        setStream((prev) =>
          prev.runId === event.runId
            ? {
                ...prev,
                proposals: prev.proposals.map((p) =>
                  p.id === event.proposalId ? { ...p, status: 'applied' } : p,
                ),
              }
            : prev,
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'check-armed') {
        // Arming writes only to the project's harness.json (no run/stream change);
        // the arm action surfaces its own success toast, so this notice is a no-op.
        return;
      }
      // harness-* events only apply to the run currently displayed/driven.
      if (event.runId !== activeRunId.current) return;
      setStream((prev) => foldHarness(prev, event));
      if (
        event.type === 'harness-scan-completed' ||
        event.type === 'harness-scan-failed'
      ) {
        void reconcile(event.runId);
      }
    },
  });
  const { stream, setStream, runStart, refreshRuns } = scan;

  const start = useCallback(
    async (
      categories: ConventionCategory[],
      model: string | null,
      effort: string | null,
    ) => {
      await runStart(hasProject && categories.length > 0, async () => {
        const runId = await startHarnessScan(categories, {
          model,
          effort: effort as EffortLevel | null,
        });
        // Optimistic running state until `harness-scan-started` lands.
        return {
          runId,
          optimistic: {
            ...EMPTY_HARNESS_STREAM,
            runId,
            status: 'running',
            model,
            requestedCategories: categories,
            categoryState: seedStepState(categories),
          },
        };
      });
    },
    [hasProject, runStart],
  );

  const dismissFinding = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await dismissHarnessFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const restoreFinding = useCallback(
    async (findingId: string) => {
      if (stream.runId === null) return;
      const run = await restoreHarnessFinding(stream.runId, findingId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const convertFinding = useCallback(
    async (findingId: string): Promise<Task | null> => {
      if (stream.runId === null) return null;
      const task = await convertHarnessFindingToTask(stream.runId, findingId);
      // Optimistic flip from the returned task id (the command returns a Task, not the
      // updated run); refreshRuns reconciles history. The `finding-converted` notice
      // above idempotently applies the same flip for any other open view.
      setStream((prev) => ({
        ...prev,
        findings: prev.findings.map((f) =>
          f.id === findingId
            ? { ...f, status: 'converted', linkedTaskId: task.id }
            : f,
        ),
      }));
      await refreshRuns();
      return task;
    },
    [stream.runId, setStream, refreshRuns],
  );

  const dismissProposal = useCallback(
    async (proposalId: string) => {
      if (stream.runId === null) return;
      const run = await dismissHarnessProposal(stream.runId, proposalId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const restoreProposal = useCallback(
    async (proposalId: string) => {
      if (stream.runId === null) return;
      const run = await restoreHarnessProposal(stream.runId, proposalId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const convertProposal = useCallback(
    async (proposalId: string): Promise<Task | null> => {
      if (stream.runId === null) return null;
      const task = await convertHarnessProposal(stream.runId, proposalId);
      // Optimistic flip from the returned task id; the `proposal-converted` notice
      // idempotently applies the same flip for any other open view.
      setStream((prev) => ({
        ...prev,
        proposals: prev.proposals.map((p) =>
          p.id === proposalId
            ? { ...p, status: 'converted', linkedTaskId: task.id }
            : p,
        ),
      }));
      await refreshRuns();
      return task;
    },
    [stream.runId, setStream, refreshRuns],
  );

  const applyProposal = useCallback(
    async (proposalId: string) => {
      if (stream.runId === null) return;
      // Writes every bundled artifact to disk — `apply_harness_proposal` rejects on a
      // refused overwrite (or an agent-task proposal with no artifacts); let it
      // propagate so the confirm dialog can surface the error inline.
      const run = await applyHarnessProposal(stream.runId, proposalId);
      // The write succeeded. The `proposal-applied` + per-artifact `artifact-applied`
      // notices already drive authoritative state; the run-list reconcile is
      // best-effort, so a `listHarnessRuns` failure here must NOT re-open the dialog.
      setStream(streamFromRun(run));
      await refreshRuns().catch((err) => {
        console.error('listHarnessRuns failed', err);
      });
    },
    [stream.runId, setStream, refreshRuns],
  );

  const dismissArtifact = useCallback(
    async (artifactId: string) => {
      if (stream.runId === null) return;
      const run = await dismissHarnessArtifact(stream.runId, artifactId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const restoreArtifact = useCallback(
    async (artifactId: string) => {
      if (stream.runId === null) return;
      const run = await restoreHarnessArtifact(stream.runId, artifactId);
      if (run !== null) setStream(streamFromRun(run));
      await refreshRuns();
    },
    [stream.runId, setStream, refreshRuns],
  );

  const applyArtifact = useCallback(
    async (artifactId: string) => {
      if (stream.runId === null) return;
      // Writes to disk — `apply_harness_artifact` rejects on a refused overwrite;
      // let it propagate so the confirm dialog can surface the error inline.
      const run = await applyHarnessArtifact(stream.runId, artifactId);
      // The write succeeded — from the user's perspective the apply is DONE.
      // The post-write run-list reconcile is best-effort (the `artifact-applied`
      // listener already drives authoritative state), so a `listHarnessRuns`
      // failure here must NOT surface as a write failure and re-open the confirm
      // dialog. Isolate it in its own catch and log rather than rethrow.
      setStream(streamFromRun(run));
      await refreshRuns().catch((err) => {
        console.error('listHarnessRuns failed', err);
      });
    },
    [stream.runId, setStream, refreshRuns],
  );

  const armCheck = useCallback(
    async (name: string, kind: string, command: string) => {
      if (stream.runId === null) return;
      // Writes only to the project's harness.json; the `check-armed` notice is a
      // no-op for the stream, so nothing to reconcile here.
      await armHarnessGauntletCheck(stream.runId, name, kind, command);
    },
    [stream.runId],
  );

  return {
    stream,
    runs: scan.runs,
    isStarting: scan.isStarting,
    startError: scan.startError,
    start,
    cancel: scan.cancel,
    selectRun: scan.selectRun,
    dismissFinding,
    restoreFinding,
    convertFinding,
    dismissProposal,
    restoreProposal,
    convertProposal,
    applyProposal,
    dismissArtifact,
    restoreArtifact,
    applyArtifact,
    armCheck,
  };
}

const RUNNING: CategoryProgress = 'running';

/** The Rust check kind + suggested command shown (verbatim) when arming an eslint-class
 *  artifact as a gauntlet check. `lint-plugin` is the gauntlet's kind for an ESLint gate;
 *  `npx eslint .` is the conventional whole-repo lint the user reviews + confirms. */
const ARM_SUGGESTION = { kind: 'lint-plugin', command: 'npx eslint .' } as const;

/** Order findings for display: open before dismissed, then severity (high→low). */
function sortFindings(findings: ConventionFindingVM[]): ConventionFindingVM[] {
  const statusRank = (f: ConventionFindingVM) => (f.status === 'open' ? 0 : 1);
  return [...findings].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return severityRankValue(b.severity) - severityRankValue(a.severity);
  });
}

/** Lenses that appear as tabs: those requested this scan plus any that produced
 *  findings (covers loading a past run whose requested set we project from). */
function tabCategories(stream: HarnessStream): ConventionCategory[] {
  const present = new Set<ConventionCategory>(stream.requestedCategories);
  for (const f of stream.findings) present.add(f.category);
  return ALL_CATEGORIES.filter((c) => present.has(c));
}

function openCount(
  findings: ConventionFindingVM[],
  category?: ConventionCategory,
): number {
  return findings.filter(
    (f) =>
      f.status === 'open' && (category === undefined || f.category === category),
  ).length;
}

/** Which body section is showing: the convention grid, the task-shaped proposals,
 *  the file-level artifacts, or the runtime-policy editor + injection scan. */
export type HarnessSection = 'conventions' | 'proposals' | 'artifacts' | 'policy';

/** Everything the HarnessView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface HarnessViewModel {
  hasProject: boolean;
  projectName: string | null;
  stream: HarnessStream;
  isStarting: boolean;
  startError: string | null;
  /** Which lifecycle screen the shell renders: configure / running / results. */
  phase: RunPhase;
  /** Collapsed-config summary text (`⌖ Opus 4.8 · high · 8 lenses`). */
  summary: string;
  /** Return to CONFIGURE ("New run") with the last run's config pre-filled. */
  reconfigure: () => void;
  /** Lifted CONFIGURE run config (survives phase swaps, pre-fills on a new run).
   *  The shared shape Insight uses too. */
  config: RunConfig<ConventionCategory>;
  /** RUNNING-screen RunProgress inputs (view-agnostic shape). */
  progressCategories: RunProgressCategory[];
  categoryRunState: Record<string, CategoryRunState>;
  findingCounts: Record<string, number>;
  synthesizing: boolean;
  /** Progressive reveal: the finished lens peeked while others run, or `null`. */
  peekCategory: ConventionCategory | null;
  peekLabel: string | null;
  peekFindings: ConventionFindingVM[];
  openCategory: (key: string) => void;
  clearPeek: () => void;
  /** Run-history menu entries (newest first), each selecting that run. */
  runHistory: MenuItem[];
  /** Whether to surface the history affordance (≥1 persisted run). */
  hasHistory: boolean;
  /** Whether the profile banner should show its skeleton (scan running, no profile). */
  profileLoading: boolean;
  /** Which body section is active, and the toggle. */
  section: HarnessSection;
  setSection: (section: HarnessSection) => void;
  /** Section-toggle badge counts: open findings, open proposals, proposed artifacts. */
  conventionCount: number;
  proposalCount: number;
  artifactCount: number;
  /** Convention-lens tabs + active tab. */
  tabs: CategoryTab[];
  activeTab: 'all' | ConventionCategory;
  setActiveTab: (key: 'all' | ConventionCategory) => void;
  gridFindings: ConventionFindingVM[];
  skeletonCount: number;
  emptyMessage: string;
  /** Task-shaped proposals panel inputs (the convert-to-task units). */
  proposals: HarnessProposalVM[];
  proposalsLoading: boolean;
  proposalsEmptyMessage: string;
  /** File-level artifacts panel inputs. */
  artifacts: ProposedArtifactVM[];
  artifactsLoading: boolean;
  artifactsEmptyMessage: string;
  /** The finding open in the detail panel, or `null`. */
  selectedFinding: ConventionFindingVM | null;
  openFinding: (finding: ConventionFindingVM) => void;
  closeFinding: () => void;
  /** The proposal open in the detail panel, or `null`. */
  selectedProposal: HarnessProposalVM | null;
  openProposal: (proposal: HarnessProposalVM) => void;
  closeProposal: () => void;
  /** Whether any proposal is still convertible (drives the "Convert all" affordance). */
  hasConvertibleProposals: boolean;
  /** The artifact open in the detail panel, or `null`. */
  selectedArtifact: ProposedArtifactVM | null;
  openArtifact: (artifact: ProposedArtifactVM) => void;
  closeArtifact: () => void;
  /** True while a finding/artifact action (dismiss/restore) is in flight. */
  pending: boolean;
  /** The artifact awaiting apply confirmation, or `null` (drives the dialog). */
  applyTarget: ProposedArtifactVM | null;
  /** True while the apply write is in flight. */
  applying: boolean;
  /** The error returned by the apply write, or `null`. */
  applyError: string | null;
  /** Launch a scan from the lifted CONFIGURE config. */
  onScan: () => void;
  onCancel: () => void;
  onConvertFinding: (findingId: string) => void;
  onDismissFinding: (findingId: string) => void;
  onRestoreFinding: (findingId: string) => void;
  /** Task-shaped proposal lifecycle actions. */
  onConvertProposal: (proposalId: string) => void;
  /** Open the bundle-apply confirmation for an `apply-artifacts` proposal. */
  onApplyProposal: (proposalId: string) => void;
  onDismissProposal: (proposalId: string) => void;
  onRestoreProposal: (proposalId: string) => void;
  /** Convert every still-convertible proposal in one action. */
  onConvertAllProposals: () => void;
  /** The proposal awaiting bundle-apply confirmation, or `null` (drives the dialog). */
  applyProposalTarget: HarnessProposalVM | null;
  /** The repo-relative paths the bundle-apply would write (shown in the dialog). */
  applyProposalPaths: string[];
  /** Confirm the bundle apply (writes every referenced artifact to disk). */
  confirmApplyProposal: () => void;
  /** Dismiss the bundle-apply confirmation. */
  cancelApplyProposal: () => void;
  /** Navigate to the board (after convert-to-task / for a converted finding). */
  onGotoBoard?: () => void;
  onDismissArtifact: (artifactId: string) => void;
  onRestoreArtifact: (artifactId: string) => void;
  /** Open the apply confirmation for an artifact. */
  requestApply: (artifactId: string) => void;
  /** Confirm the apply (writes to disk). */
  confirmApply: () => void;
  /** Dismiss the apply confirmation. */
  cancelApply: () => void;
  /** The applied artifact awaiting arm confirmation, or `null` (drives the arm dialog). */
  armTarget: ProposedArtifactVM | null;
  /** The command that arming will write to the manifest (shown verbatim — the gate). */
  armCommand: string;
  /** Open the arm confirmation for an applied artifact. */
  requestArm: (artifactId: string) => void;
  /** Confirm arming (writes the check into `.nightcore/harness.json`). */
  confirmArm: () => void;
  /** Dismiss the arm confirmation. */
  cancelArm: () => void;
}

/** Resolve the entire Harness surface into a single view model: the live/persisted
 *  stream (via `useHarness`), the section/tab + selected finding/artifact UI state,
 *  the apply-confirm flow, and every derived list. The component shell renders
 *  purely from this. */
export function useHarnessView({
  projectPath,
  projectName,
  onGotoBoard,
  preselect,
  onPreselectConsumed,
}: HarnessViewProps): HarnessViewModel {
  const hasProject = projectPath !== null;
  const harness = useHarness(hasProject);
  const { stream } = harness;

  const [section, setSection] = useState<HarnessSection>('conventions');
  const [activeTab, setActiveTab] = useState<'all' | ConventionCategory>('all');
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [applyTargetId, setApplyTargetId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [armTargetId, setArmTargetId] = useState<string | null>(null);
  const [applyProposalTargetId, setApplyProposalTargetId] = useState<string | null>(null);

  // Lifted CONFIGURE run config (the shared shape Insight uses too). It lives here
  // (not in RunControls) so the config survives the CONFIGURE → RUNNING → RESULTS
  // phase swaps and pre-fills on a new run. `reconfiguring` is the explicit "New
  // run" override that returns RESULTS to CONFIGURE without discarding the run.
  const config = useRunConfig(!hasProject);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [peekCategory, setPeekCategory] = useState<ConventionCategory | null>(null);

  // Board→scan provenance navigation: a task's `sourceRef` chip landed here with
  // a run + item to open. Consume the target FIRST, land on that run's RESULTS in
  // the owning section, and open the item's detail panel — a convention finding or
  // a proposal, per the token's `kind`.
  usePreselectNavigation({
    preselect,
    onPreselectConsumed,
    selectRun: harness.selectRun,
    onEnter: () => {
      setReconfiguring(false);
      setPeekCategory(null);
    },
    onOpenItem: ({ itemId, kind }) => {
      if (kind === 'proposal') {
        setSection('proposals');
        setSelectedProposalId(itemId);
      } else {
        setSection('conventions');
        setActiveTab('all');
        setSelectedFindingId(itemId);
      }
    },
  });

  const phase: RunPhase = deriveRunPhase(stream.status, harness.isStarting, reconfiguring);

  // "New run": pre-fill the form from the last run's model + lenses, then drop back
  // to CONFIGURE. (Effort isn't persisted on a run, so the lifted value carries.)
  // prefill resets the model even to null (a default-model rerun), so the form
  // never keeps a stale model — mirrors Insight.
  const reconfigure = useCallback(() => {
    config.prefill({
      model: stream.model,
      categories: stream.requestedCategories,
    });
    setPeekCategory(null);
    setReconfiguring(true);
  }, [config, stream.model, stream.requestedCategories]);

  const onScan = useCallback(() => {
    setReconfiguring(false);
    setPeekCategory(null);
    void harness.start(config.orderedSelected, config.model, config.effort);
  }, [harness, config]);

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

  const findingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of stream.findings) {
      counts[f.category] = (counts[f.category] ?? 0) + 1;
    }
    return counts;
  }, [stream.findings]);

  const peekFindings = useMemo(
    () =>
      peekCategory === null
        ? []
        : sortFindings(stream.findings.filter((f) => f.category === peekCategory)),
    [peekCategory, stream.findings],
  );

  const visibleCategories = useMemo(() => tabCategories(stream), [stream]);

  const tabs: CategoryTab[] = useMemo(() => {
    const runningCount = Object.values(stream.categoryState).filter(
      (s) => s === RUNNING,
    ).length;
    const head: CategoryTab = {
      key: 'all',
      count: openCount(stream.findings),
      running: runningCount > 0,
      errored: false,
    };
    return [
      head,
      ...visibleCategories.map((c) => ({
        key: c,
        count: openCount(stream.findings, c),
        running: stream.categoryState[c] === RUNNING,
        errored: stream.categoryState[c] === 'error',
      })),
    ];
  }, [stream, visibleCategories]);

  const gridFindings = useMemo(() => {
    const filtered =
      activeTab === 'all'
        ? stream.findings
        : stream.findings.filter((f) => f.category === activeTab);
    return sortFindings(filtered);
  }, [stream.findings, activeTab]);

  const skeletonCount = useMemo(() => {
    if (stream.status !== 'running') return 0;
    if (activeTab === 'all') {
      const running = Object.values(stream.categoryState).filter(
        (s) => s === RUNNING,
      ).length;
      return Math.min(6, running * 2);
    }
    return stream.categoryState[activeTab] === RUNNING ? 3 : 0;
  }, [stream.status, stream.categoryState, activeTab]);

  const selectedFinding = useMemo(
    () => stream.findings.find((f) => f.id === selectedFindingId) ?? null,
    [stream.findings, selectedFindingId],
  );
  const selectedProposal = useMemo(
    () => stream.proposals.find((p) => p.id === selectedProposalId) ?? null,
    [stream.proposals, selectedProposalId],
  );
  const selectedArtifact = useMemo(
    () => stream.artifacts.find((a) => a.id === selectedArtifactId) ?? null,
    [stream.artifacts, selectedArtifactId],
  );
  const applyTarget = useMemo(
    () => stream.artifacts.find((a) => a.id === applyTargetId) ?? null,
    [stream.artifacts, applyTargetId],
  );
  const armTarget = useMemo(
    () => stream.artifacts.find((a) => a.id === armTargetId) ?? null,
    [stream.artifacts, armTargetId],
  );
  const applyProposalTarget = useMemo(
    () => stream.proposals.find((p) => p.id === applyProposalTargetId) ?? null,
    [stream.proposals, applyProposalTargetId],
  );
  // The repo-relative paths the bundle would write (resolved from the referenced
  // artifacts), shown verbatim in the confirm dialog so the user sees exactly what lands.
  const applyProposalPaths = useMemo(() => {
    if (applyProposalTarget === null) return [];
    return applyProposalTarget.artifactIds
      .map((id) => stream.artifacts.find((a) => a.id === id)?.targetPath)
      .filter((p): p is string => typeof p === 'string');
  }, [applyProposalTarget, stream.artifacts]);

  const runHistory: MenuItem[] = useMemo(
    () =>
      harness.runs.map((run) => ({
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.findings.length} conventions`,
        onClick: () => {
          // Selecting a past run lands on its RESULTS — drop any reconfigure/peek.
          setReconfiguring(false);
          setPeekCategory(null);
          void harness.selectRun(run.id);
        },
      })),
    [harness],
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

  const proposalsEmptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run a scan to synthesize task-shaped proposals from your conventions.';
    }
    if (stream.status === 'failed') {
      return `Scan failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No proposals synthesized for this scan.';
  }, [stream.status, stream.error]);

  const artifactsEmptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run a scan to synthesize a proposed harness from your conventions.';
    }
    if (stream.status === 'failed') {
      return `Scan failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No harness artifacts proposed for this scan.';
  }, [stream.status, stream.error]);

  const toast = useToast();
  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending(true);
      try {
        await fn();
      } catch (err) {
        // Fired as `void runAction(...)`, so without this catch a failed action would
        // only clear `pending` and vanish into the generic global toast. Mirror the
        // Insight sibling: log + a labeled toast through the routed-failure channel.
        console.error(`${label} failed`, err);
        toast.error(`Could not ${label}`, err);
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

  const confirmApply = useCallback(() => {
    if (applyTargetId === null) return;
    const id = applyTargetId;
    setApplying(true);
    setApplyError(null);
    void (async () => {
      try {
        await harness.applyArtifact(id);
        setApplyTargetId(null);
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplying(false);
      }
    })();
  }, [applyTargetId, harness]);

  const cancelApply = useCallback(() => {
    if (applying) return;
    setApplyTargetId(null);
    setApplyError(null);
  }, [applying]);

  const confirmArm = useCallback(() => {
    const target = stream.artifacts.find((a) => a.id === armTargetId) ?? null;
    if (target === null) return;
    const name = target.groupTitle ?? target.title;
    setArmTargetId(null);
    void runAction('arm gauntlet check', async () => {
      await harness.armCheck(name, ARM_SUGGESTION.kind, ARM_SUGGESTION.command);
      toast.push({
        tone: 'success',
        title: 'Structure-Lock check armed',
        description: `${name} now runs before every task in this project.`,
      });
    });
  }, [stream.artifacts, armTargetId, runAction, harness, toast]);

  const cancelArm = useCallback(() => setArmTargetId(null), []);

  // Bundle-apply confirmation: writing every referenced artifact to disk is a
  // consequential action, so it goes through a confirm dialog (like arm-check). On
  // confirm, `runAction` surfaces any partial-failure/agent-task error as a toast.
  const confirmApplyProposal = useCallback(() => {
    if (applyProposalTargetId === null) return;
    const id = applyProposalTargetId;
    const count = applyProposalPaths.length;
    setApplyProposalTargetId(null);
    void runAction('apply proposal bundle', async () => {
      await harness.applyProposal(id);
      toast.push({
        tone: 'success',
        title: 'Proposal applied',
        description: `${count} ${count === 1 ? 'artifact' : 'artifacts'} written to disk.`,
      });
    });
  }, [applyProposalTargetId, applyProposalPaths.length, runAction, harness, toast]);

  const cancelApplyProposal = useCallback(() => setApplyProposalTargetId(null), []);

  // Convert every still-convertible proposal (status `proposed`) in one action, mirroring
  // Insight's convert-all. Sequential so a mid-flight failure surfaces without racing the
  // store; the `proposal-converted` notice keeps the stream in sync as each lands.
  const convertibleProposals = useMemo(
    () => stream.proposals.filter((p) => p.status === 'proposed'),
    [stream.proposals],
  );
  const onConvertAllProposals = useCallback(() => {
    if (convertibleProposals.length === 0) return;
    void runAction('convert all proposals', async () => {
      for (const p of convertibleProposals) {
        await harness.convertProposal(p.id);
      }
      toast.push({
        tone: 'success',
        title: 'Proposals converted',
        description: `${convertibleProposals.length} ${
          convertibleProposals.length === 1 ? 'proposal' : 'proposals'
        } converted to board tasks.`,
      });
    });
  }, [convertibleProposals, runAction, harness, toast]);

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
    peekCategory,
    peekLabel: peekCategory === null ? null : CATEGORY_META[peekCategory].label,
    peekFindings,
    openCategory: (key: string) => setPeekCategory(key as ConventionCategory),
    clearPeek: () => setPeekCategory(null),
    runHistory,
    hasHistory: harness.runs.length > 0,
    profileLoading: stream.status === 'running' && stream.profile === null,
    section,
    setSection,
    conventionCount: openCount(stream.findings),
    proposalCount: stream.proposals.filter((p) => p.status === 'proposed').length,
    artifactCount: stream.artifacts.filter((a) => a.status === 'proposed').length,
    tabs,
    activeTab,
    setActiveTab,
    gridFindings,
    skeletonCount,
    emptyMessage,
    proposals: stream.proposals,
    proposalsLoading: stream.status === 'running' && stream.proposals.length === 0,
    proposalsEmptyMessage,
    artifacts: stream.artifacts,
    artifactsLoading: stream.status === 'running' && stream.artifacts.length === 0,
    artifactsEmptyMessage,
    selectedFinding,
    openFinding: (finding: ConventionFindingVM) => setSelectedFindingId(finding.id),
    closeFinding: () => setSelectedFindingId(null),
    selectedProposal,
    openProposal: (proposal: HarnessProposalVM) => setSelectedProposalId(proposal.id),
    closeProposal: () => setSelectedProposalId(null),
    hasConvertibleProposals: convertibleProposals.length > 0,
    selectedArtifact,
    openArtifact: (artifact: ProposedArtifactVM) => setSelectedArtifactId(artifact.id),
    closeArtifact: () => setSelectedArtifactId(null),
    pending,
    applyTarget,
    applying,
    applyError,
    onScan,
    onCancel: () => void harness.cancel(),
    onConvertFinding: (id) => void runAction('convert convention', () => harness.convertFinding(id)),
    onDismissFinding: (id) => void runAction('dismiss convention', () => harness.dismissFinding(id)),
    onRestoreFinding: (id) => void runAction('restore convention', () => harness.restoreFinding(id)),
    onConvertProposal: (id) => void runAction('convert proposal', () => harness.convertProposal(id)),
    onApplyProposal: (id) => setApplyProposalTargetId(id),
    onDismissProposal: (id) => void runAction('dismiss proposal', () => harness.dismissProposal(id)),
    onRestoreProposal: (id) => void runAction('restore proposal', () => harness.restoreProposal(id)),
    onConvertAllProposals,
    applyProposalTarget,
    applyProposalPaths,
    confirmApplyProposal,
    cancelApplyProposal,
    onGotoBoard,
    onDismissArtifact: (id) => void runAction('dismiss artifact', () => harness.dismissArtifact(id)),
    onRestoreArtifact: (id) => void runAction('restore artifact', () => harness.restoreArtifact(id)),
    requestApply: (id) => {
      setApplyError(null);
      setApplyTargetId(id);
    },
    confirmApply,
    cancelApply,
    armTarget,
    armCommand: ARM_SUGGESTION.command,
    requestArm: (id) => setArmTargetId(id),
    confirmArm,
    cancelArm,
  };
}
