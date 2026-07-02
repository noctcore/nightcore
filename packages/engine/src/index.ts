/**
 * @nightcore/engine — public façade.
 *
 * Surfaces import ONLY from here (plus `@nightcore/contracts` for types). The
 * SDK is never re-exported: `SessionManager` is the entire surface a client
 * needs to drive the engine via `SurfaceCommand`s and consume `NightcoreEvent`s.
 */
export { HookBus } from './policy/hook-bus.js';
export type {
  ApprovalDecision,
  PermissionPromptRequest,
} from './policy/permission-layer.js';
export { PermissionLayer } from './policy/permission-layer.js';
export { ToolRegistry } from './policy/tool-registry.js';
export type { KindPreset } from './session/kind-presets.js';
export {
  NETWORK_EGRESS_TOOLS,
  resolveKindPreset,
  WRITE_TOOLS,
} from './session/kind-presets.js';
export { SessionManager } from './session/session-manager.js';
export type { SessionRunnerConfig } from './session/session-runner.js';
export { SessionRunner } from './session/session-runner.js';
// Decompose result parsing: turns a `decompose` session's final text into the
// validated `proposedSubtasks` carried on `session-completed` (mirrors `parseFindings`).
export type { ProposedSubtask } from './session/decompose.js';
export { parseSubtasks } from './session/decompose.js';

// The Insight (codebase analysis) orchestrator + its pure parse/ground/dedup
// helpers. The SDK stays confined to the SessionRunner the manager spins.
export type { AnalysisManagerDeps } from './scans/insight/manager.js';
export { AnalysisManager } from './scans/insight/manager.js';
export {
  dedupeFindings,
  extractJson,
  fingerprintOf,
  groundFindings,
  parseFindings,
  severityRank,
} from './scans/shared/findings.js';
export type { AnalysisPreset } from './scans/shared/presets.js';
export {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  analysisPreset,
  ANALYZER_PERSONA,
  outputContract,
} from './scans/shared/presets.js';

// The Harness (codebase convention auditor) orchestrator + its pure helpers: the
// deterministic repo profiler, the parse/ground/dedup convention helpers, the
// per-lens presets, and the artifact synthesis pass. SDK stays confined to the
// SessionRunner the manager spins.
export {
  conventionFingerprint,
  dedupeConventionFindings,
  groundConventionFindings,
  parseConventionFindings,
} from './scans/harness/findings.js';
export type {
  HarnessManagerDeps,
  HarnessRunnerFactory,
  HarnessSessionRunner,
} from './scans/harness/manager.js';
export { HarnessManager } from './scans/harness/manager.js';
export type { HarnessPreset } from './scans/harness/presets.js';
export {
  conventionOutputContract,
  harnessPreset,
} from './scans/harness/presets.js';
export { HARNESS_REFERENCE } from './scans/harness/reference.js';
export { detectRepoProfile } from './scans/harness/repo-profile.js';
export type {
  SynthesizeHarnessArgs,
  SynthesizeHarnessResult,
} from './scans/harness/synthesis.js';
export { parseProposedArtifacts,synthesizeHarness } from './scans/harness/synthesis.js';

// The PR Review orchestrator (the fourth scan sibling) + its pure DIFF-relative
// parse/ground/dedup helpers, per-lens presets, and the adversarial finding-validator
// pass. SDK stays confined to the SessionRunner the manager spins.
export {
  dedupePrReviewFindings,
  groundPrReviewFindings,
  parsePrReviewFindings,
  reviewFingerprint,
  reviewSeverityRank,
} from './scans/pr-review/findings.js';
export type {
  PrReviewManagerDeps,
  PrReviewRunnerFactory,
  PrReviewSessionRunner,
} from './scans/pr-review/manager.js';
export { PrReviewScanManager } from './scans/pr-review/manager.js';
export type { PrReviewPreset } from './scans/pr-review/presets.js';
export {
  PR_REVIEW_ALLOWED_TOOLS,
  PR_REVIEW_DISALLOWED_TOOLS,
  PR_REVIEW_PRESETS,
  PR_REVIEWER_PERSONA,
  prReviewOutputContract,
  prReviewPreset,
} from './scans/pr-review/presets.js';
export type {
  ValidatePrReviewArgs,
  ValidatePrReviewResult,
} from './scans/pr-review/validator.js';
export { validatePrReviewFindings } from './scans/pr-review/validator.js';

// The Readiness Scorecard (Profile) orchestrator + its pure parse/ground helpers
// and per-dimension presets. SDK stays confined to the SessionRunner the manager
// spins. Mirrors the Insight orchestrator tier-for-tier.
export type {
  ScorecardManagerDeps,
  ScorecardRunnerFactory,
  ScorecardSessionRunner,
} from './scans/scorecard/manager.js';
export { ScorecardManager } from './scans/scorecard/manager.js';
export type { ScorecardPreset } from './scans/scorecard/presets.js';
export {
  readingOutputContract,
  SCORECARD_ALLOWED_TOOLS,
  SCORECARD_DISALLOWED_TOOLS,
  scorecardPreset,
} from './scans/scorecard/presets.js';
export { groundReading,parseReading } from './scans/scorecard/readings.js';

// The SDK session store surface (list/read/rename/tag of past sessions), behind a
// thin degrade-not-throw façade. The SDK itself stays confined to `sdk-adapter`.
export type {
  GetTaskSessionMessagesOptions,
  ListTaskSessionsOptions,
  SDKSessionInfo,
  SessionMessage,
} from './session/session-api.js';
export { SessionApi } from './session/session-api.js';

// The read-only provider-config inspector reader (degrade-not-throw per section).
export { ProviderConfigReader } from './providers/provider-config.js';

// The message-translation boundary is exported for testing only — surfaces
// should not need it.
export type { TranslateResult } from './session/sdk-adapter.js';
export { translateMessage } from './session/sdk-adapter.js';
