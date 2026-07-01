/**
 * @nightcore/engine — public façade.
 *
 * Surfaces import ONLY from here (plus `@nightcore/contracts` for types). The
 * SDK is never re-exported: `SessionManager` is the entire surface a client
 * needs to drive the engine via `SurfaceCommand`s and consume `NightcoreEvent`s.
 */
export { SessionManager } from './session/session-manager.js';
export { ToolRegistry } from './policy/tool-registry.js';
export { PermissionLayer } from './policy/permission-layer.js';
export type {
  PermissionPromptRequest,
  ApprovalDecision,
} from './policy/permission-layer.js';
export { HookBus } from './policy/hook-bus.js';
export { SessionRunner } from './session/session-runner.js';
export type { SessionRunnerConfig } from './session/session-runner.js';
export {
  resolveKindPreset,
  WRITE_TOOLS,
  NETWORK_EGRESS_TOOLS,
} from './session/kind-presets.js';
export type { KindPreset } from './session/kind-presets.js';
// Decompose result parsing: turns a `decompose` session's final text into the
// validated `proposedSubtasks` carried on `session-completed` (mirrors `parseFindings`).
export { parseSubtasks } from './session/decompose.js';
export type { ProposedSubtask } from './session/decompose.js';

// The Insight (codebase analysis) orchestrator + its pure parse/ground/dedup
// helpers. The SDK stays confined to the SessionRunner the manager spins.
export { AnalysisManager } from './scans/insight/manager.js';
export type { AnalysisManagerDeps } from './scans/insight/manager.js';
export {
  parseFindings,
  groundFindings,
  dedupeFindings,
  fingerprintOf,
  extractJson,
  severityRank,
} from './scans/shared/findings.js';
export {
  analysisPreset,
  outputContract,
  ANALYZER_PERSONA,
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
} from './scans/shared/presets.js';
export type { AnalysisPreset } from './scans/shared/presets.js';

// The Harness (codebase convention auditor) orchestrator + its pure helpers: the
// deterministic repo profiler, the parse/ground/dedup convention helpers, the
// per-lens presets, and the artifact synthesis pass. SDK stays confined to the
// SessionRunner the manager spins.
export { HarnessManager } from './scans/harness/manager.js';
export type {
  HarnessManagerDeps,
  HarnessRunnerFactory,
  HarnessSessionRunner,
} from './scans/harness/manager.js';
export { detectRepoProfile } from './scans/harness/repo-profile.js';
export {
  parseConventionFindings,
  groundConventionFindings,
  dedupeConventionFindings,
  conventionFingerprint,
} from './scans/harness/findings.js';
export {
  harnessPreset,
  conventionOutputContract,
} from './scans/harness/presets.js';
export type { HarnessPreset } from './scans/harness/presets.js';
export { synthesizeHarness, parseProposedArtifacts } from './scans/harness/synthesis.js';
export type {
  SynthesizeHarnessArgs,
  SynthesizeHarnessResult,
} from './scans/harness/synthesis.js';
export { HARNESS_REFERENCE } from './scans/harness/reference.js';

// The Readiness Scorecard (Profile) orchestrator + its pure parse/ground helpers
// and per-dimension presets. SDK stays confined to the SessionRunner the manager
// spins. Mirrors the Insight orchestrator tier-for-tier.
export { ScorecardManager } from './scans/scorecard/manager.js';
export type {
  ScorecardManagerDeps,
  ScorecardRunnerFactory,
  ScorecardSessionRunner,
} from './scans/scorecard/manager.js';
export { parseReading, groundReading } from './scans/scorecard/readings.js';
export {
  scorecardPreset,
  readingOutputContract,
  SCORECARD_ALLOWED_TOOLS,
  SCORECARD_DISALLOWED_TOOLS,
} from './scans/scorecard/presets.js';
export type { ScorecardPreset } from './scans/scorecard/presets.js';

// The SDK session store surface (list/read/rename/tag of past sessions), behind a
// thin degrade-not-throw façade. The SDK itself stays confined to `sdk-adapter`.
export { SessionApi } from './session/session-api.js';
export type {
  SDKSessionInfo,
  SessionMessage,
  ListTaskSessionsOptions,
  GetTaskSessionMessagesOptions,
} from './session/session-api.js';

// The read-only provider-config inspector reader (degrade-not-throw per section).
export { ProviderConfigReader } from './providers/provider-config.js';

// The message-translation boundary is exported for testing only — surfaces
// should not need it.
export { translateMessage } from './session/sdk-adapter.js';
export type { TranslateResult } from './session/sdk-adapter.js';
