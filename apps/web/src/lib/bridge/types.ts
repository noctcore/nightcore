/**
 * The web↔Rust bridge's TYPE surface: the generated ts-rs re-exports (Rust→TS
 * codegen) plus the contract (`@nightcore/contracts`) re-exports the board consumes.
 * This is the single hub the other bridge submodules import their shared types from,
 * so knowledge of the generated file layout lives in exactly one place.
 */
import type { NightcoreEvent } from '@nightcore/contracts';

export type { SessionStatus } from '@nightcore/contracts';

export interface ToolCheck {
  id: string;
  label: string;
  installed: boolean;
  authenticated: boolean | null;
  path: string | null;
  version: string | null;
  detail: string;
  fixHint: string;
  fixCommand: string;
}

export interface OnboardingPrerequisites {
  claude: ToolCheck;
  codex: ToolCheck;
  gh: ToolCheck;
  git: ToolCheck;
}

// --- Generated IPC types (Rust→TS codegen) --------------------------------
//
// These types are GENERATED from the Rust serde structs by `ts-rs` (run via
// `cargo test` in `apps/desktop/src-tauri`; output under `./generated/`). They
// replace the hand-mirrored interfaces that used to live here, so a Rust field
// rename can no longer silently break the board — `cargo test` regenerates the
// bindings and the CI drift guard (`git diff` over `generated/`) fails on any
// mismatch. The runtime invoke/listen wrappers + zod re-validation below are
// UNCHANGED; only the type DECLARATIONS now come from the generated bindings.
export type { AppInfo } from '../generated/AppInfo';
export type { BoardAppearance } from '../generated/BoardAppearance';
export type { BoardBackgroundRef } from '../generated/BoardBackgroundRef';
export type { BranchInfo } from '../generated/BranchInfo';
export type { DetectedEditor } from '../generated/DetectedEditor';
export type { DiffFileStat } from '../generated/DiffFileStat';
export type { DiffStatus } from '../generated/DiffStatus';
export type { GauntletResult } from '../generated/GauntletResult';
export type { GauntletStep } from '../generated/GauntletStep';
export type { LoopEnvelope } from '../generated/LoopEnvelope';
export type { McpServerEntry } from '../generated/McpServerEntry';
export type { McpServerSummary } from '../generated/McpServerSummary';
export type { McpServerTransport } from '../generated/McpServerTransport';
export type { MergePreview } from '../generated/MergePreview';
export type { MergePreviewStatus } from '../generated/MergePreviewStatus';
export type { PrComment } from '../generated/PrComment';
export type { PrCommentTriage } from '../generated/PrCommentTriage';
export type { PrCommentTriageClass } from '../generated/PrCommentTriageClass';
export type { PrDraft } from '../generated/PrDraft';
export type { Project } from '../generated/Project';
export type { ProviderConfigSection } from '../generated/ProviderConfigSection';
export type { ProviderConfigSnapshot } from '../generated/ProviderConfigSnapshot';
export type { PrReviewComments } from '../generated/PrReviewComments';
export type { PrReviewSummary } from '../generated/PrReviewSummary';
export type { PrStatus } from '../generated/PrStatus';
export type { PrSupport } from '../generated/PrSupport';
export type { PrThread } from '../generated/PrThread';
export type { RunMode } from '../generated/RunMode';
export type { SessionInfo } from '../generated/SessionInfo';
export type { SessionMessage } from '../generated/SessionMessage';
export type { Settings } from '../generated/Settings';
export type { SettingsOverride } from '../generated/SettingsOverride';
export type { SettingsPatch } from '../generated/SettingsPatch';
export type { SkillSummary } from '../generated/SkillSummary';
export type { StructureLockCheck } from '../generated/StructureLockCheck';
export type { StructureLockResult } from '../generated/StructureLockResult';
export type { SubagentSummary } from '../generated/SubagentSummary';
export type { Task } from '../generated/Task';
export type { TaskAttachment } from '../generated/TaskAttachment';
export type { TaskPatch } from '../generated/TaskPatch';
export type { TaskStatus } from '../generated/TaskStatus';
// Trust Report — the per-task governance receipt (ts-rs from `workflow/trust/
// contract.rs`, wayfinder #91). One `TrustReport` aggregating the merge-time
// gauntlet/reviewer truth, the guardrail ledger tiers, and the flight summary.
export type { FlightSummary } from '../generated/FlightSummary';
export type { GauntletTrust } from '../generated/GauntletTrust';
export type { GuardrailEvent } from '../generated/GuardrailEvent';
export type { GuardrailTrust } from '../generated/GuardrailTrust';
export type { QuarantineEvent } from '../generated/QuarantineEvent';
export type { TokenTotals } from '../generated/TokenTotals';
export type { TrustReport } from '../generated/TrustReport';
// GitHub issue-map export (ts-rs from `workflow/issue_map/contract.rs`, wayfinder
// #112). The transient preview payload the dialog renders (parent body + every
// sub-issue title + group counts + supersede + soft warning + the fail-open LLM
// narrative), and the terminal export result (full / partial / degraded-linkage).
// `Narrative` is the generated file `IssueMapNarrative.ts` (the type is `Narrative`).
export type { GroupCount } from '../generated/GroupCount';
export type { GroupIntro } from '../generated/GroupIntro';
export type { Narrative } from '../generated/IssueMapNarrative';
export type { IssueMapPreview } from '../generated/IssueMapPreview';
export type { IssueMapResult } from '../generated/IssueMapResult';
export type { PriorMap } from '../generated/PriorMap';
export type { SubIssuePreview } from '../generated/SubIssuePreview';
// User terminal (PTY) command-return shapes (ts-rs from `terminal/types.rs`). PR B
// consumes the live-session descriptor; PR C's restore UI adds the persisted-
// scrollback metadata (`PersistedTerminalInfo`) + replay bytes
// (`PersistedTerminalScrollback`).
export type { PersistedTerminalInfo } from '../generated/PersistedTerminalInfo';
export type { PersistedTerminalScrollback } from '../generated/PersistedTerminalScrollback';
export type { TerminalSessionInfo } from '../generated/TerminalSessionInfo';
export type { WorktreeDiff } from '../generated/WorktreeDiff';
export type { WorktreeDiffFile } from '../generated/WorktreeDiffFile';
export type { WorktreeInfo } from '../generated/WorktreeInfo';
// Insight (codebase analysis) persisted shapes (ts-rs from `store/insight.rs`).
export type { FindingLocation } from '../generated/FindingLocation';
export type { InsightRun } from '../generated/InsightRun';
export type { InsightUsage } from '../generated/InsightUsage';
export type { StoredFinding } from '../generated/StoredFinding';
// The unified Insight taxonomy comes from the zod contract (the engine's wire
// shape); the generated `StoredFinding` keeps these as `string`, so the Insight
// view casts to these unions.
export type {
  AnalysisScope,
  EffortLevel,
  Finding,
  FindingCategory,
  FindingEffort,
  FindingSeverity,
} from '@nightcore/contracts';
// The dynamic model catalog (`list_models`) + provider capability
// descriptor (`get_capabilities`) come straight from the zod contract — the same
// wire shapes the engine emits, so the picker reads live descriptors/capabilities
// without a hand-mirrored interface.
export type {
  AutonomyLevel,
  CostTelemetry,
  ModelDescriptor,
  ProviderCapabilities,
} from '@nightcore/contracts';
// Readiness Scorecard (Profile) persisted shapes (ts-rs from `store/scorecard.rs`).
export type { ScorecardEvidence } from '../generated/ScorecardEvidence';
export type { ScorecardRun } from '../generated/ScorecardRun';
export type { StoredReading } from '../generated/StoredReading';
// The Scorecard taxonomy comes from the zod contract (the engine's wire shape); the
// generated `StoredReading` keeps `dimension`/`grade` as `string`, so the Scorecard
// view casts to these unions.
export type {
  ScorecardDimension,
  ScorecardGrade,
  ScorecardReading,
} from '@nightcore/contracts';
// Harness (codebase convention auditor) persisted shapes (ts-rs from `store/harness.rs`).
export type { HarnessRun } from '../generated/HarnessRun';
export type { HarnessUsage } from '../generated/HarnessUsage';
export type { StoredConventionFinding } from '../generated/StoredConventionFinding';
export type { StoredHarnessCheck } from '../generated/StoredHarnessCheck';
export type { StoredHarnessProposal } from '../generated/StoredHarnessProposal';
export type { StoredProposedArtifact } from '../generated/StoredProposedArtifact';
export type { StoredRepoPackage } from '../generated/StoredRepoPackage';
export type { StoredRepoProfile } from '../generated/StoredRepoProfile';
// ENFORCE-lite rule coverage (ts-rs from `store/harness/wire.rs`). The generated
// `Stored*` keeps `status` as `string`; the coverage `CoverageStatus` union + the
// live wire `RuleCoverageGap` come from the zod contract below.
export type { StoredRuleCoverageGap } from '../generated/StoredRuleCoverageGap';
// Harness policy authoring (ts-rs from `commands/policy.rs`) + the injection-scan
// flag rows (ts-rs from `store/injection_scan.rs`).
export type { HarnessPolicyFile } from '../generated/HarnessPolicyFile';
export type { HarnessPolicyPatch } from '../generated/HarnessPolicyPatch';
export type { InjectionFlag } from '../generated/InjectionFlag';
export type { PolicyDiffBudget } from '../generated/PolicyDiffBudget';
// The harness convention taxonomy + proposed-artifact shapes come from the zod
// contract (the engine's wire shape); the generated `Stored*` types keep the
// enum-ish fields as `string`, so the Harness view casts to these unions.
export type {
  ArtifactKind,
  ArtifactWriteMode,
  ConventionCategory,
  ConventionFinding,
  ConventionKind,
  CoverageStatus,
  HarnessCheck,
  HarnessProposal,
  HarnessProposalKind,
  ProposedArtifact,
  RepoPackage,
  RepoProfile,
  RuleCoverageGap,
  WorkspaceTool,
} from '@nightcore/contracts';
// PR Review (fourth scan sibling) persisted shapes (ts-rs from `store/pr_review.rs`).
// `PrReviewRun` reuses the shared `InsightUsage` token totals; `StoredReviewFinding`
// is the Rust `StoredReviewFinding` (its ts-rs `export_to="ReviewFinding.ts"`).
export type { PrReviewRun } from '../generated/PrReviewRun';
export type { StoredReviewFinding } from '../generated/ReviewFinding';
// The PR-review lens/severity taxonomy + the live wire `ReviewFinding` come from the
// zod contract (the engine's wire shape); the generated `StoredReviewFinding` keeps
// `lens`/`severity`/`status` as `string`, so the PR Review view casts to these unions.
export type { ReviewFinding, ReviewLens, ReviewSeverity } from '@nightcore/contracts';
// Open-PR summaries + labels for the PR Review config picker (ts-rs from `workflow/pr_list.rs`).
export type { PrLabel } from '../generated/PrLabel';
export type { PrSummary } from '../generated/PrSummary';
// One changed file (path + line deltas) for the workspace's changed-file expander
// (ts-rs from `workflow/pr_changed_files.rs`).
export type { PrChangedFile } from '../generated/PrChangedFile';
// Address-review-findings fix snapshots (ts-rs from `workflow/pr_fix/state.rs`):
// the full state emitted on every `nc:pr-fix` change and listed by `list_pr_fixes`.
export type { PrFixState } from '../generated/PrFixState';
// Issue Triage (GitHub issue intake + validation) persisted shapes (ts-rs from
// `store/issue_triage.rs`). `IssueValidationRun` reuses the shared `InsightUsage`
// token totals; `StoredIssueValidationResult` / `StoredIssuePrAnalysis` keep their
// enum-ish fields as `string`, so the Issue Triage view casts to the unions below.
export type { IssueValidationRun } from '../generated/IssueValidationRun';
export type { StoredIssuePrAnalysis } from '../generated/StoredIssuePrAnalysis';
export type { StoredIssueValidationResult } from '../generated/StoredIssueValidationResult';
// The issue-triage taxonomy + list/detail wire shapes come from the zod contract
// (the `gh` seam's / engine's shape); the generated `Stored*` types keep the enum
// fields as `string`, so the Issue Triage view casts to these unions.
export type {
  IssueComment,
  IssueComplexity,
  IssueConfidence,
  IssueKind,
  IssueLinkedPr,
  IssuePrAnalysis,
  IssuePrRecommendation,
  IssuePrState,
  IssueState,
  IssueSummary,
  IssueValidationResult,
  IssueVerdict,
} from '@nightcore/contracts';

/** The kind preset a task runs under and the four UI permission modes are
 *  generated FROM the Rust enums (`TaskKind` / `PermissionMode` in
 *  `store/task.rs`) rather than re-declared, so the board's pickers can't drift
 *  from the authoritative serde mapping. The generated `TaskKind` is byte-identical
 *  to the contracts `TaskKindSchema` enum (same snake_case wire union); the
 *  generated `PermissionMode` is the studio's per-task UI vocabulary
 *  (`bypass`/`auto-accept`/`ask`/`plan`), distinct from the contracts SDK
 *  `PermissionMode` — it always lived here, never in contracts. */
export type { PermissionMode } from '../generated/PermissionMode';
export type { TaskKind } from '../generated/TaskKind';
/** Decompose: a proposed sub-task + its convert lifecycle, generated from the Rust
 *  `ProposedSubtask` / `SubtaskStatus` so the detail panel can't drift from serde. */
export type { ProposedSubtask } from '../generated/ProposedSubtask';
export type { SubtaskStatus } from '../generated/SubtaskStatus';

/** The full engine event union streamed inside the `nc:session` envelope. This is
 *  the AUTHORITATIVE contract (`@nightcore/contracts` → `NightcoreEventSchema`),
 *  not a hand-maintained subset — so the board can never silently drift from what
 *  the engine emits (e.g. the `task-updated` subagent-step event the board used to
 *  drop). The Rust core forwards each event verbatim; `onSessionEvent` /
 *  `readTranscript` validate the wire against `NightcoreEventSchema` before use. */
export type NcEvent = NightcoreEvent;
export type { NightcoreEvent } from '@nightcore/contracts';
export type { QuestionAnswer, QuestionItem, QuestionOption } from '@nightcore/contracts';
