/**
 * The Council debate engine — public surface (issues #348 / #349 / #350).
 *
 * The moderated bus + append-only transcript store (the injection firewall), the
 * preset-as-data registry + validator, and the Conductor state machine that drives
 * them. Re-exported from the engine barrel so the sidecar's `start-council` /
 * `kill-council` command family (routed through `SessionManager`) and the future
 * canvas bridge (#352) have ONE sanctioned import surface instead of reaching into
 * `debate/*` internals. A #357 gate LOW noted the foundation modules weren't exported
 * yet; the Conductor is their first consumer.
 */
export type {
  BroadcastClock,
  BroadcastDispatch,
  BroadcastResult,
  CollectBroadcastInput,
  SeatBroadcastOutcome,
  SeatBroadcastStatus,
} from './broadcast-collector.js';
export {
  collectBroadcast,
  DEFAULT_SEAT_CONCURRENCY,
  DEFAULT_SEAT_TIMEOUT_MS,
} from './broadcast-collector.js';
export type {
  ConductorBus,
  DeliveryOutcome,
  InterSeatDelivery,
  SeatBusView,
  SeatMessage,
} from './bus.js';
export { DebateBus } from './bus.js';
export type { ConductorDeps, CouncilRunInput } from './conductor.js';
export { Conductor } from './conductor.js';
export { RunGovernor } from './conductor-budget.js';
export type {
  BudgetHaltCause,
  CouncilRunResult,
  CouncilRunStatus,
  CouncilRunUsage,
  PendingConvergeDecision,
  SeatContext,
  SeatDriver,
  SeatPosition,
  SeatTurnRequest,
  SeatTurnResult,
  TurnEstimate,
} from './conductor-types.js';
export type {
  CouncilManagerDeps,
  StartCouncilInput,
} from './council-manager.js';
export { CouncilManager } from './council-manager.js';
export type {
  DebateDispatchConfig,
  DebateHalt,
  DebateOutcome,
  DebateRoundHooks,
} from './debate-round.js';
export { runDebateRounds } from './debate-round.js';
export type { InjectionScanResult } from './injection-scan.js';
export { scanForInjection } from './injection-scan.js';
export type { PeerContext, PeerOutput } from './peer-context.js';
export { assemblePeerContext } from './peer-context.js';
export {
  COUNCIL_PRESETS,
  RESEARCH_COUNCIL_PRESET,
  resolveCouncilPreset,
} from './preset-registry.js';
export type {
  CouncilPresetIssue,
  CouncilPresetIssueCode,
  CouncilPresetValidation,
} from './preset-validator.js';
export {
  COUNCIL_MAX_SEATS,
  COUNCIL_MIN_DISTINCT_MODELS,
  validateCouncilPreset,
} from './preset-validator.js';
export type { QuotedDelivery } from './quoted-delivery.js';
export { quoteForSeat } from './quoted-delivery.js';
export {
  type SeatSessionBackend,
  type SeatSessionParams,
  SessionSeatDriver,
  type SessionSeatDriverDeps,
} from './session-seat-driver.js';
export {
  type Clock,
  type DebateEntryInput,
  DebateTranscriptStore,
} from './transcript-store.js';
