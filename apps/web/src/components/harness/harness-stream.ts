/**
 * The live Harness reducer: folds the `harness-*` event stream into a view model,
 * the same incremental-fold shape `insight-stream.ts` uses for Insight. Also holds
 * the normalizers that map the two sources for each shape — the live wire
 * `ConventionFinding` / `ProposedArtifact` / `RepoProfile` (contract) and the
 * persisted `Stored*` (ts-rs) — into the single view models the UI renders.
 *
 * Harness adds two hops over Insight: a `harness-profile-ready` up front (the
 * deterministic repo profile, drives the ProfileBanner) and a
 * `harness-proposals-ready` near the end (the synthesized artifacts, drive the
 * proposed-harness panel) — both folded incrementally before the terminal event.
 */
import { ConventionCategorySchema } from '@nightcore/contracts';
import type {
  ConventionCategory,
  ConventionFinding,
  HarnessProposal,
  HarnessRun,
  HarnessScanEvent,
  ProposedArtifact,
  RepoProfile,
} from '@/lib/bridge';
import {
  addUsage,
  makeScanFold,
  narrowMembers,
  normalizeLocation,
  runStatusFromPersisted,
  seedStepStateFromRun,
} from '@/lib/scan-run';

import type {
  CategoryProgress,
  ConventionFindingVM,
  HarnessProposalVM,
  ProposedArtifactVM,
  RepoProfileVM,
  RuleCoverageGapVM,
  RunStatus,
} from './harness.types';
import { storedToCoverageGap, wireToCoverageGap } from './harness-coverage';
import {
  storedToArtifact,
  storedToConventionFinding,
  storedToProfile,
  storedToProposal,
} from './harness-stored';

/** The stable `reason` carried on the terminal `harness-scan-failed` event — lets
 *  RESULTS tell a user cancel (`aborted`) apart from a real failure. */
export type HarnessFailureReason = Extract<
  HarnessScanEvent,
  { type: 'harness-scan-failed' }
>['reason'];

/** Deep mode (issue #294): one lens's round progress — the 1-based round index and how
 *  many net-new (post-dedup) findings that round contributed. Keyed by lens in
 *  {@link HarnessStream.categoryRounds}; a missing key means that lens hasn't completed a
 *  round yet (classic single-pass scans never populate this map at all). */
export interface CategoryRoundInfo {
  round: number;
  newFindingsThisRound: number;
}

export interface HarnessStream {
  runId: string | null;
  status: RunStatus;
  model: string | null;
  requestedCategories: ConventionCategory[];
  categoryState: Record<string, CategoryProgress>;
  /** The detected repo profile, once `harness-profile-ready` lands (else `null`). */
  profile: RepoProfileVM | null;
  findings: ConventionFindingVM[];
  artifacts: ProposedArtifactVM[];
  /** The task-shaped proposals synthesis produced (the convert-to-task units). */
  proposals: HarnessProposalVM[];
  /** ENFORCE-lite coverage — one per convention; empty until the run completes. */
  coverage: RuleCoverageGapVM[];
  /** Deep mode (issue #294): per-lens round progress, keyed by lens. Empty for a classic
   *  single-pass scan (which never emits round events). */
  categoryRounds: Record<string, CategoryRoundInfo>;
  /** True between `harness-synthesis-started` and the terminal event — the dead-zone
   *  after every lens reads "done" but synthesis still runs (drives the shimmer). */
  synthesizing: boolean;
  /** Why synthesis failed on an otherwise-successful scan (#401), else `null`. The
   *  lens findings are real; the artifacts/proposals are missing. */
  synthesisError: string | null;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error: string | null;
  /** The terminal failure `reason` once `harness-scan-failed` lands (else `null`) —
   *  lets RESULTS show a user `aborted` cancel neutrally. Not persisted. */
  failureReason: HarnessFailureReason | null;
}

export const EMPTY_HARNESS_STREAM: HarnessStream = {
  runId: null,
  status: 'idle',
  model: null,
  requestedCategories: [],
  categoryState: {},
  profile: null,
  findings: [],
  artifacts: [],
  proposals: [],
  coverage: [],
  categoryRounds: {},
  synthesizing: false,
  synthesisError: null,
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  durationMs: 0,
  error: null,
  failureReason: null,
};

/** Map a live wire `ConventionFinding` (contract) into the view shape — it is
 *  always `open` when it streams in (lifecycle is applied on persist). */
export function wireToConventionFinding(f: ConventionFinding): ConventionFindingVM {
  return {
    id: f.id,
    category: f.category,
    kind: f.kind,
    severity: f.severity,
    title: f.title,
    description: f.description,
    rationale: f.rationale ?? null,
    evidence: (f.evidence ?? []).map((e) => normalizeLocation(e)),
    suggestion: f.suggestion ?? null,
    tags: f.tags ?? [],
    confidence: f.confidence ?? null,
    fingerprint: f.fingerprint,
    status: 'open',
    linkedTaskId: null,
  };
}

/** Map a live wire `ProposedArtifact` (contract) into the view shape — it is
 *  always `proposed` (unapplied) when it streams in. */
export function wireToArtifact(a: ProposedArtifact): ProposedArtifactVM {
  return {
    id: a.id,
    kind: a.kind,
    group: a.group ?? null,
    groupTitle: a.groupTitle ?? null,
    title: a.title,
    description: a.description,
    rationale: a.rationale ?? null,
    targetPath: a.targetPath,
    writeMode: a.writeMode,
    content: a.content,
    language: a.language ?? null,
    sourceFindings: a.sourceFindings ?? [],
    dependsOn: a.dependsOn ?? [],
    confidence: a.confidence ?? null,
    fingerprint: a.fingerprint,
    status: 'proposed',
    appliedPath: null,
    appliedAt: null,
  };
}

/** Map a live wire `HarnessProposal` (contract) into the view shape — always
 *  `proposed` (unconverted) when it streams in (lifecycle is applied on persist). */
export function wireToProposal(p: HarnessProposal): HarnessProposalVM {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    description: p.description,
    rationale: p.rationale ?? null,
    artifactIds: p.artifactIds ?? [],
    prompt: p.prompt ?? null,
    verifyCommand: p.verifyCommand ?? null,
    harnessCheck: p.harnessCheck ?? null,
    confidence: p.confidence ?? null,
    fingerprint: p.fingerprint,
    status: 'proposed',
    linkedTaskId: null,
  };
}

/** Map a live wire `RepoProfile` (contract) into the ProfileBanner view shape. */
export function wireToProfile(p: RepoProfile): RepoProfileVM {
  return {
    isMonorepo: p.isMonorepo,
    workspaceTool: p.workspaceTool,
    packages: p.packages ?? [],
    languages: p.languages ?? [],
    frameworks: p.frameworks ?? [],
    hasEslintFlatConfig: p.hasEslintFlatConfig,
    hasLintMeta: p.hasLintMeta,
    hasAgentDocs: p.hasAgentDocs,
    existingPlugins: p.existingPlugins ?? [],
  };
}

/** Project a persisted run into the same `HarnessStream` shape the live fold
 *  produces, so the view renders both from one model. */
export function streamFromRun(run: HarnessRun): HarnessStream {
  const status: RunStatus = runStatusFromPersisted(run.status);
  // Drop any persisted category that isn't a contract member rather than seed a
  // bogus stepper lens.
  const categories = narrowMembers(ConventionCategorySchema, run.categories);
  return {
    runId: run.id,
    status,
    model: run.model || null,
    requestedCategories: categories,
    // While synthesizing, every lens has finished — project them all `done` so a
    // reloaded mid-synthesis run shows the finished stepper + the synthesis row,
    // not a row of pending lenses. (A still-scanning running run carries no
    // per-category completion, so it falls back to `pending`.)
    categoryState: seedStepStateFromRun(
      categories,
      status === 'running' && !run.synthesizing,
    ),
    profile: storedToProfile(run.profile),
    findings: run.findings.map(storedToConventionFinding),
    artifacts: run.artifacts.map(storedToArtifact),
    proposals: run.proposals.map(storedToProposal),
    coverage: run.coverage.map(storedToCoverageGap),
    // Deep mode (issue #294): the persisted per-lens round count survives
    // reconcile/resume; `newFindingsThisRound` isn't persisted (a point-in-time delta),
    // so a reloaded run reports 0 for it.
    categoryRounds: Object.fromEntries(
      Object.entries(run.roundsByCategory).map(([category, round]) => [
        category,
        { round, newFindingsThisRound: 0 },
      ]),
    ),
    // Persisted on the run (set on harness-synthesis-started, cleared on
    // proposals-ready/terminal), so a run reloaded during the multi-minute serial
    // synthesis tail still shows the "Synthesizing…" state instead of a frozen
    // all-lenses-done dead zone.
    synthesizing: run.synthesizing,
    synthesisError: run.synthesisError ?? null,
    costUsd: run.costUsd,
    usage: run.usage,
    durationMs: run.durationMs,
    error: run.error,
    // The reason isn't persisted (only the error message), so a reloaded cancel
    // can't be told apart from a crash — leave it null.
    failureReason: null,
  };
}

/** Fold one `harness-*` scan event into the live stream (the shared scan
 *  skeleton; see `makeScanFold` in `@/lib/scan-run`). Harness's two extra hops
 *  (`profile-ready`, `synthesis-started`/`proposals-ready`) ride the `apply`
 *  escape hatch; the terminals additionally settle `synthesizing`. */
export const foldHarness = makeScanFold<
  HarnessScanEvent,
  HarnessStream,
  ConventionFindingVM,
  ConventionCategory,
  HarnessFailureReason
>({
  empty: EMPTY_HARNESS_STREAM,
  steps: {
    state: (s) => s.categoryState,
    requested: (s) => s.requestedCategories,
  },
  items: { read: (s) => s.findings, stepOf: (f) => f.category },
  write: (s, patch) => ({
    ...s,
    ...patch.core,
    ...(patch.stepState === undefined
      ? undefined
      : { categoryState: patch.stepState }),
    ...(patch.requestedSteps === undefined
      ? undefined
      : { requestedCategories: patch.requestedSteps }),
    ...(patch.items === undefined ? undefined : { findings: patch.items }),
    ...patch.extra,
  }),
  classify: (event) => {
    switch (event.type) {
      case 'harness-scan-started':
        return {
          kind: 'started',
          runId: event.runId,
          model: event.model,
          steps: event.categories,
        };
      case 'harness-profile-ready':
        return {
          kind: 'apply',
          next: (prev) => ({ ...prev, profile: wireToProfile(event.profile) }),
        };
      case 'harness-category-started':
        return { kind: 'step-started', step: event.category };
      case 'harness-category-completed':
        return {
          kind: 'step-completed',
          step: event.category,
          items: event.findings.map(wireToConventionFinding),
          errored: Boolean(event.error),
          costUsd: event.costUsd,
          usage: event.usage,
        };
      // Deep mode (issue #294): one round of a lens's multi-round loop finished.
      // `event.findings` is already the CUMULATIVE grounded set for that lens across
      // every round so far, so this REPLACES (not appends to) the lens's slice of
      // `findings` — the same replace-by-step shape `step-completed` uses, via the
      // `apply` escape hatch so the lens stays `running` (more rounds may still land;
      // deep mode never emits a per-lens terminal event).
      case 'harness-category-round-completed':
        return {
          kind: 'apply',
          next: (prev) => ({
            ...prev,
            findings: [
              ...prev.findings.filter((f) => f.category !== event.category),
              ...event.findings.map(wireToConventionFinding),
            ],
            costUsd: prev.costUsd + event.costUsd,
            usage: addUsage(prev.usage, event.usage),
            categoryRounds: {
              ...prev.categoryRounds,
              [event.category]: {
                round: event.round,
                newFindingsThisRound: event.newFindingsThisRound,
              },
            },
          }),
        };
      case 'harness-synthesis-started':
        // Every lens has settled; the serial synthesis tail is now running. Flip
        // the flag so RunProgress can show the synthesis row instead of a frozen,
        // all-"done" board.
        return { kind: 'apply', next: (prev) => ({ ...prev, synthesizing: true }) };
      case 'harness-proposals-ready':
        return {
          kind: 'apply',
          next: (prev) => ({
            ...prev,
            artifacts: event.artifacts.map(wireToArtifact),
            proposals: event.proposals.map(wireToProposal),
            synthesizing: false,
          }),
        };
      case 'harness-scan-completed':
        return {
          kind: 'completed',
          items: event.findings.map(wireToConventionFinding),
          costUsd: event.costUsd,
          usage: event.usage,
          durationMs: event.durationMs,
          extra: {
            synthesizing: false,
            profile: wireToProfile(event.profile),
            artifacts: event.artifacts.map(wireToArtifact),
            proposals: event.proposals.map(wireToProposal),
            coverage: event.coverage.map(wireToCoverageGap),
          },
        };
      case 'harness-scan-failed':
        return {
          kind: 'failed',
          message: event.message,
          reason: event.reason,
          extra: { synthesizing: false },
        };
    }
  },
});
