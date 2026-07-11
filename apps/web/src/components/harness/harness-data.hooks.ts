/** The Harness data layer: `useHarness` drives the live/persisted run — the
 *  `harness-*` fold, authoritative reconciliation on completion, and the
 *  finding / proposal / artifact lifecycle actions. Split out of the
 *  HarnessView mega-hook so the view model composes it (mirrors the prreview
 *  `prreview-runs.hooks.ts` data layer). */
import { useCallback } from 'react';

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
import { patchStreamItem, seedStepState } from '@/lib/scan-run';
import { useScanItemActions } from '@/lib/useScanItemActions';
import type { ScanRunApi, ScanRunConfig } from '@/lib/useScanRun';

import type {
  ConventionFindingVM,
  HarnessProposalVM,
  ProposedArtifactVM,
} from './harness.types';
import {
  EMPTY_HARNESS_STREAM,
  foldHarness,
  type HarnessStream,
  streamFromRun,
} from './harness-stream';

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
    providerId: string | null,
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
  armCheck: (
    name: string,
    kind: string,
    command: string,
    requireWired?: string | null,
  ) => Promise<void>;
}

/** The Harness run-lifecycle config for the shared {@link useScanRun}: the bridge
 *  seams, the persisted→live projection, and the live-event body (the `harness-*`
 *  fold plus the single-item `*-converted` / `*-applied` / `check-armed` side
 *  effects). Extracted so the `useScanRun` call itself lives in
 *  `HarnessView.hooks.ts` — the scan-family-parity home — while this data-layer
 *  wiring stays encapsulated here. */
export function harnessScanConfig(): ScanRunConfig<
  HarnessEvent,
  HarnessRun,
  HarnessStream
> {
  return {
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
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.artifactId,
            items: (s) => s.artifacts,
            write: (s, artifacts) => ({ ...s, artifacts }),
            patch: (a) => ({ ...a, status: 'applied' as const, appliedPath: event.path }),
          }),
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'finding-converted') {
        // patchStreamItem matches on stream.runId (NOT the activeRunId gate below)
        // so a convert against a displayed-but-not-live run still updates in place
        // — mirrors Insight.
        setStream((prev) =>
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.findingId,
            items: (s) => s.findings,
            write: (s, findings) => ({ ...s, findings }),
            patch: (f) => ({ ...f, status: 'converted' as const, linkedTaskId: event.taskId }),
          }),
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'proposal-converted') {
        setStream((prev) =>
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.proposalId,
            items: (s) => s.proposals,
            write: (s, proposals) => ({ ...s, proposals }),
            patch: (p) => ({ ...p, status: 'converted' as const, linkedTaskId: event.taskId }),
          }),
        );
        void refreshRuns();
        return;
      }
      if (event.type === 'proposal-applied') {
        // The bundle's per-artifact writes each emit their own `artifact-applied`
        // notice (which flips the artifact rows); this one flips the PROPOSAL to
        // applied.
        setStream((prev) =>
          patchStreamItem(prev, {
            runId: event.runId,
            itemId: event.proposalId,
            items: (s) => s.proposals,
            write: (s, proposals) => ({ ...s, proposals }),
            patch: (p) => ({ ...p, status: 'applied' as const }),
          }),
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
  };
}

/** Drive the Harness data layer over the shared run-lifecycle {@link scan}: the
 *  scan launch and the finding / proposal / artifact lifecycle actions. The
 *  `useScanRun` call itself lives in `HarnessView.hooks.ts` (parity home); it is
 *  wired from {@link harnessScanConfig} and passed in here. */
export function useHarness(
  scan: ScanRunApi<HarnessRun, HarnessStream>,
  hasProject: boolean,
): UseHarnessResult {
  const { stream, setStream, runStart, refreshRuns } = scan;

  const start = useCallback(
    async (
      categories: ConventionCategory[],
      model: string | null,
      effort: string | null,
      providerId: string | null,
    ) => {
      await runStart(hasProject && categories.length > 0, async () => {
        const runId = await startHarnessScan(categories, {
          model,
          effort: effort as EffortLevel | null,
          providerId,
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

  // The shared dismiss/restore/convert triple, instantiated per item family.
  // The convert mark is optimistic (the command returns a Task, not the updated
  // run); refreshRuns reconciles history, and the `finding-converted` /
  // `proposal-converted` notices idempotently apply the same flip for any other
  // open view.
  const {
    dismiss: dismissFinding,
    restore: restoreFinding,
    convert: convertFinding,
  } = useScanItemActions<HarnessRun, HarnessStream, ConventionFindingVM>({
    runId: stream.runId,
    setStream,
    refreshRuns,
    streamFromRun,
    items: (s) => s.findings,
    writeItems: (s, findings) => ({ ...s, findings }),
    dismissItem: dismissHarnessFinding,
    restoreItem: restoreHarnessFinding,
    convert: {
      run: convertHarnessFindingToTask,
      mark: (f, taskId) => ({ ...f, status: 'converted' as const, linkedTaskId: taskId }),
    },
  });

  const {
    dismiss: dismissProposal,
    restore: restoreProposal,
    convert: convertProposal,
  } = useScanItemActions<HarnessRun, HarnessStream, HarnessProposalVM>({
    runId: stream.runId,
    setStream,
    refreshRuns,
    streamFromRun,
    items: (s) => s.proposals,
    writeItems: (s, proposals) => ({ ...s, proposals }),
    dismissItem: dismissHarnessProposal,
    restoreItem: restoreHarnessProposal,
    convert: {
      run: convertHarnessProposal,
      mark: (p, taskId) => ({ ...p, status: 'converted' as const, linkedTaskId: taskId }),
    },
  });

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
      await refreshRuns().catch(() => {
        // best-effort reconcile; authoritative state already updated via events; swallow.
      });
    },
    [stream.runId, setStream, refreshRuns],
  );

  const { dismiss: dismissArtifact, restore: restoreArtifact } =
    useScanItemActions<HarnessRun, HarnessStream, ProposedArtifactVM>({
      runId: stream.runId,
      setStream,
      refreshRuns,
      streamFromRun,
      items: (s) => s.artifacts,
      writeItems: (s, artifacts) => ({ ...s, artifacts }),
      dismissItem: dismissHarnessArtifact,
      restoreItem: restoreHarnessArtifact,
      // Artifacts have no convert-to-task; `applyArtifact` below is their write path.
    });

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
      // dialog. Isolate it in its own catch and swallow rather than rethrow.
      setStream(streamFromRun(run));
      await refreshRuns().catch(() => {
        // best-effort reconcile; authoritative state already updated via events; swallow.
      });
    },
    [stream.runId, setStream, refreshRuns],
  );

  const armCheck = useCallback(
    async (name: string, kind: string, command: string, requireWired: string | null = null) => {
      if (stream.runId === null) return;
      // Writes only to the project's harness.json; the `check-armed` notice is a
      // no-op for the stream, so nothing to reconcile here. `requireWired` (the
      // applied plugin path) lets Rust refuse a placebo `lint-plugin` arm.
      await armHarnessGauntletCheck(stream.runId, name, kind, command, requireWired);
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
