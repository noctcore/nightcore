/**
 * @nightcore/engine — public façade.
 *
 * Surfaces import ONLY from here (plus `@nightcore/contracts` for types). The
 * SDK is never re-exported: `SessionManager` is the entire surface a client
 * needs to drive the engine via `SurfaceCommand`s and consume `NightcoreEvent`s.
 */
export { SessionManager } from './session-manager.js';
export { ToolRegistry } from './tool-registry.js';
export { PermissionLayer } from './permission-layer.js';
export type {
  PermissionPromptRequest,
  ApprovalDecision,
} from './permission-layer.js';
export { HookBus } from './hook-bus.js';
export { SessionRunner } from './session-runner.js';
export type { SessionRunnerConfig } from './session-runner.js';
export { resolveKindPreset, WRITE_TOOLS } from './kind-presets.js';
export type { KindPreset } from './kind-presets.js';

// The Insight (codebase analysis) orchestrator + its pure parse/ground/dedup
// helpers. The SDK stays confined to the SessionRunner the manager spins.
export { AnalysisManager } from './analysis-manager.js';
export type { AnalysisManagerDeps } from './analysis-manager.js';
export {
  parseFindings,
  groundFindings,
  dedupeFindings,
  fingerprintOf,
  extractJson,
  severityRank,
} from './analysis-findings.js';
export {
  analysisPreset,
  outputContract,
  ANALYZER_PERSONA,
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
} from './analysis-presets.js';
export type { AnalysisPreset } from './analysis-presets.js';

// The SDK session store surface (list/read/rename/tag of past sessions), behind a
// thin degrade-not-throw façade. The SDK itself stays confined to `sdk-adapter`.
export { SessionApi } from './session-api.js';
export type {
  SDKSessionInfo,
  SessionMessage,
  ListTaskSessionsOptions,
  GetTaskSessionMessagesOptions,
} from './session-api.js';

// The read-only provider-config inspector reader (degrade-not-throw per section).
export { ProviderConfigReader } from './provider-config.js';

// The message-translation boundary is exported for testing only — surfaces
// should not need it.
export { translateMessage } from './sdk-adapter.js';
export type { TranslateResult } from './sdk-adapter.js';
