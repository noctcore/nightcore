import { z } from 'zod';
import { PermissionModeSchema } from './config.js';
import {
  AnalysisScopeSchema,
  FindingCategorySchema,
  FindingSchema,
} from './insight.js';
import {
  ConventionCategorySchema,
  ConventionFindingSchema,
  ProposedArtifactSchema,
  RepoProfileSchema,
} from './harness.js';
import {
  ScorecardDimensionSchema,
  ScorecardReadingSchema,
} from './scorecard.js';
import { ProviderConfigSnapshotSchema } from './provider-config.js';
import { SessionStatusSchema } from './session.js';
import { ToolRiskSchema } from './tools.js';

/**
 * `NightcoreEvent` — the typed stream flowing engine → surface.
 *
 * The SessionRunner translates each raw `SDKMessage` into one of these. Every
 * event carries `sessionId` (Nightcore's monotonic id) so a single surface can
 * multiplex several concurrent sessions. This union is the entire contract a
 * surface needs to render a session — surfaces never see `SDKMessage`.
 */

const base = {
  /** Monotonic Nightcore session id this event belongs to. */
  sessionId: z.number().int().nonnegative(),
};

/** Session accepted and the SDK subprocess is warming up. */
export const SessionStartedEvent = z.object({
  ...base,
  type: z.literal('session-started'),
  prompt: z.string(),
  model: z.string(),
  permissionMode: PermissionModeSchema,
});

/** The SDK emitted its `init` system message; carries the real SDK session id
 *  plus the session's available slash commands and skills (from settingSources),
 *  which the surface folds into its command palette. */
export const SessionReadyEvent = z.object({
  ...base,
  type: z.literal('session-ready'),
  sdkSessionId: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  /** SDK-native slash command names (from `.claude/commands`, plugins, builtins). */
  slashCommands: z.array(z.string()).default([]),
  /** Skill names discovered for this session (from `.claude/skills`). */
  skills: z.array(z.string()).default([]),
});

/** Status of an SDK task/subagent step, mirroring the SDK's `task_updated`
 *  patch status superset. */
export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
  'paused',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** A task/subagent step started or changed. The surface merges these by
 *  `taskId` into a live task panel. Folded from the SDK's `task_started` /
 *  `task_updated` / `task_progress` / `task_notification` system messages. */
export const TaskUpdatedEvent = z.object({
  ...base,
  type: z.literal('task-updated'),
  taskId: z.string(),
  status: TaskStatusSchema.optional(),
  /** Human description of what the task is doing. */
  description: z.string().optional(),
  /** Short progress/result summary, when the SDK provides one. */
  summary: z.string().optional(),
  /** Subagent type for Task-tool subagents (e.g. `Explore`). */
  subagentType: z.string().optional(),
  /** True for ambient/housekeeping tasks the surface may hide from the inline
   *  transcript (still fine to show in a dedicated panel). */
  ambient: z.boolean().default(false),
});

/** A chunk of assistant text. For streamed deltas, `text` is the incremental
 *  piece; for whole-message fallbacks it is the full block. */
export const AssistantDeltaEvent = z.object({
  ...base,
  type: z.literal('assistant-delta'),
  text: z.string(),
  /** True when this is an incremental stream chunk vs a whole message block. */
  partial: z.boolean(),
});

/** The model requested a tool call. */
export const ToolUseRequestedEvent = z.object({
  ...base,
  type: z.literal('tool-use-requested'),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
});

/** A tool finished and produced a result (or error). */
export const ToolResultEvent = z.object({
  ...base,
  type: z.literal('tool-result'),
  toolUseId: z.string(),
  isError: z.boolean(),
  /** Stringified result content for display. */
  content: z.string(),
});

/** The harness needs an interactive approval decision for a tool call. The
 *  surface responds with an `approve-permission` command carrying `requestId`. */
export const PermissionRequiredEvent = z.object({
  ...base,
  type: z.literal('permission-required'),
  requestId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Risk class of the requested tool, so the surface can badge dangerous calls
   *  (e.g. shell exec). Absent when the tool has no Nightcore descriptor. */
  risk: ToolRiskSchema.optional(),
  /** Pre-rendered prompt sentence from the SDK, when available. */
  title: z.string().optional(),
});

/** One selectable choice for a question, mirroring the SDK's AskUserQuestion
 *  option shape (`label` / `description` / optional `preview`). */
export const QuestionOptionSchema = z.object({
  /** Short choice text the surface renders as the selectable label. */
  label: z.string(),
  /** Longer explanation of what choosing this option means. */
  description: z.string(),
  /** Optional preview content (markdown/HTML) for option comparison UIs. */
  preview: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One question in an `AskUserQuestion` call, mirroring the SDK's input shape:
 *  a prompt, a short `header` chip, 2–4 `options`, and a `multiSelect` flag.
 *  The surface ALWAYS also offers a free-text answer (the SDK auto-adds an
 *  "Other" path), so a returned answer is not constrained to an option label. */
export const QuestionItemSchema = z.object({
  /** The full question prompt to show the user. */
  question: z.string(),
  /** Very short label/chip for the question (the SDK caps it ~12 chars). */
  header: z.string(),
  /** The offered choices (the SDK guarantees 2–4). */
  options: z.array(QuestionOptionSchema),
  /** True when the user may select more than one option for this question. */
  multiSelect: z.boolean().default(false),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

/** The harness needs an interactive ANSWER to an `AskUserQuestion` tool call.
 *  Distinct from `permission-required` (allow/deny a tool): the surface picks an
 *  option or writes a free-text answer per question and replies with an
 *  `answer-question` command carrying `requestId`. Delivered over the SDK's
 *  `onUserDialog` channel (dialog kind `permission_ask_user_question`), NOT
 *  `canUseTool` — so it never auto-denies as a generic tool prompt. */
export const QuestionRequiredEvent = z.object({
  ...base,
  type: z.literal('question-required'),
  requestId: z.string(),
  /** SDK `toolUseId` of the originating AskUserQuestion call, when the dialog
   *  carries one — lets a surface correlate the prompt with its transcript entry. */
  toolUseId: z.string().optional(),
  /** The questions to ask (1–4), each with its own options. */
  questions: z.array(QuestionItemSchema),
});

/** Token usage for a completed session, distilled from the SDK result message. */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Session reached a successful terminal state. */
export const SessionCompletedEvent = z.object({
  ...base,
  type: z.literal('session-completed'),
  /** The final result text from the SDK result message. */
  result: z.string(),
  costUsd: z.number(),
  numTurns: z.number().int(),
  /** Wall-clock duration of the session in ms (SDK `duration_ms`). */
  durationMs: z.number().nonnegative().default(0),
  /** Token usage, when the SDK result reported it. */
  usage: TokenUsageSchema.optional(),
  /** Sub-task proposals parsed from the agent's final result text. Populated ONLY
   *  for `decompose`-kind sessions — the engine extracts a JSON array from the
   *  result and validates each `{ title, prompt }` against this shape (dropping
   *  blank-title items), mirroring how Insight turns a session into findings.
   *  Absent for every other kind. */
  proposedSubtasks: z
    .array(z.object({ title: z.string(), prompt: z.string() }))
    .optional(),
});

/** Session failed or the runner crashed. Degrade-not-throw: the manager always
 *  emits this rather than rejecting, mirroring shiranami's `failAllPending`. */
export const SessionFailedEvent = z.object({
  ...base,
  type: z.literal('session-failed'),
  /** Stable failure reason for the surface to branch on. */
  reason: z.enum([
    'authentication',
    'rate-limit',
    'aborted',
    'runner-crash',
    'max-turns',
    'max-budget',
    'unknown',
  ]),
  message: z.string(),
});

/** Session status transitioned (for surfaces that render a status line). */
export const SessionStatusEvent = z.object({
  ...base,
  type: z.literal('session-status'),
  status: SessionStatusSchema,
});

/**
 * Metadata for one SDK session, mirroring the SDK's `SDKSessionInfo` field-for-
 * field — these names/types are LOAD-BEARING (the Rust serde struct mirrors them
 * for the `query-result` reply). The SDK's `sessionId` is renamed to `sdkSessionId`
 * on the wire to stay consistent with `task.sdk_session_id` and avoid colliding
 * with Nightcore's numeric session-id vocabulary. Powers the per-task history view.
 */
export const SessionInfoSchema = z.object({
  /** SDK session UUID (the SDK's `sessionId`). */
  sdkSessionId: z.string(),
  /** Display title: custom title, auto-summary, or first prompt. */
  summary: z.string(),
  /** Last-modified time, ms since epoch. */
  lastModified: z.number(),
  /** File size in bytes (local JSONL only). */
  fileSize: z.number().optional(),
  /** User-set title via `/rename`. */
  customTitle: z.string().optional(),
  /** First meaningful user prompt. */
  firstPrompt: z.string().optional(),
  /** Git branch at the end of the session. */
  gitBranch: z.string().optional(),
  /** Working directory the session ran in (the cwd that keys its storage). */
  cwd: z.string().optional(),
  /** User-set session tag. */
  tag: z.string().optional(),
  /** Creation time, ms since epoch (from the first entry's timestamp). */
  createdAt: z.number().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/**
 * One message from a session transcript, mirroring the SDK's `SessionMessage`.
 * `message` is the raw Anthropic message JSON — kept as an opaque object record
 * (`z.record`, NOT `z.unknown()`, which the codegen emitter rejects). The SDK's
 * snake_case `session_id`/`parent_tool_use_id` become camelCase on the wire.
 */
export const SessionMessageSchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  /** The SDK session UUID this message belongs to (the SDK's `session_id`). */
  sessionId: z.string(),
  /** Raw Anthropic message JSON, forwarded opaquely. */
  message: z.record(z.string(), z.unknown()),
  /** Parent tool-use id for a tool-result message, or `null` (the SDK's
   *  `parent_tool_use_id`). Present on the wire; `null` when there is no parent. */
  parentToolUseId: z.string().nullable(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/**
 * The correlated reply to a `SurfaceQuery`, carrying its `requestId` so the Rust
 * core can match it to the pending request. `ok` is the success flag; `kind`
 * names which payload slot is populated. The reader INTERCEPTS this event (it is
 * an RPC reply, not a stream event to forward to the board). `info` is `null`
 * when a `get-session-info` found nothing.
 */
export const QueryResultEvent = z.object({
  type: z.literal('query-result'),
  /** Correlation id echoed from the originating `SurfaceQuery`. */
  requestId: z.string(),
  ok: z.boolean(),
  /** Which payload slot the result populates. `ack` is a bare success (rename/tag). */
  kind: z.enum([
    'sessions',
    'session-info',
    'messages',
    'ack',
    'provider-config',
  ]),
  /** Populated for `kind: 'sessions'`. */
  sessions: z.array(SessionInfoSchema).optional(),
  /** Populated for `kind: 'session-info'`; `null` when the session was not found. */
  info: SessionInfoSchema.nullable().optional(),
  /** Populated for `kind: 'messages'`. */
  messages: z.array(SessionMessageSchema).optional(),
  /** Populated for `kind: 'provider-config'`: the read-only inspector snapshot. */
  providerConfig: ProviderConfigSnapshotSchema.optional(),
  /** Set when `ok` is false: a short failure reason. */
  error: z.string().optional(),
});

/**
 * Insight analysis events. These do NOT carry `sessionId` (the category passes are
 * internal to the engine's analysis orchestrator and never surface as ordinary
 * sessions); they correlate by `runId`. The Rust reader routes the whole
 * `analysis-*` family to the `nc:insight` channel and persists the run on
 * `analysis-completed`.
 */

/** A run started. Echoes the resolved categories/scope/model for the UI header. */
export const AnalysisStartedEvent = z.object({
  type: z.literal('analysis-started'),
  runId: z.string(),
  scope: AnalysisScopeSchema,
  categories: z.array(FindingCategorySchema),
  model: z.string(),
});

/** A category pass began exploring (the UI shows skeleton cards for it). */
export const AnalysisCategoryStartedEvent = z.object({
  type: z.literal('analysis-category-started'),
  runId: z.string(),
  category: FindingCategorySchema,
});

/** A category pass finished: its grounded findings stream in as a batch, plus the
 *  pass's own token usage and cost so the UI can show per-category spend. */
export const AnalysisCategoryCompletedEvent = z.object({
  type: z.literal('analysis-category-completed'),
  runId: z.string(),
  category: FindingCategorySchema,
  findings: z.array(FindingSchema),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): findings is then empty and the
   *  UI marks the category errored rather than "0 findings". */
  error: z.string().optional(),
});

/** The whole run finished: the final cross-category-deduped findings plus run
 *  totals. The Rust reader persists from THIS event (authoritative). */
export const AnalysisCompletedEvent = z.object({
  type: z.literal('analysis-completed'),
  runId: z.string(),
  findings: z.array(FindingSchema),
  categoriesRun: z.array(FindingCategorySchema),
  costUsd: z.number(),
  durationMs: z.number().nonnegative().default(0),
  usage: TokenUsageSchema.optional(),
});

/** The run failed before completing (could not start, or aborted). */
export const AnalysisFailedEvent = z.object({
  type: z.literal('analysis-failed'),
  runId: z.string(),
  reason: z.enum(['aborted', 'runner-crash', 'unknown']),
  message: z.string(),
});

/**
 * Harness (codebase convention auditor) events. Like the `analysis-*` family these
 * carry no `sessionId` and correlate by `runId`; the Rust reader routes the whole
 * `harness-*` family to the `nc:harness` channel and persists the run on
 * `harness-scan-completed`. The flow adds two hops over Insight: a `harness-profile-ready`
 * up front (the deterministic repo profile) and a `harness-proposals-ready` near the
 * end (the synthesized artifacts), so the UI can render the profile banner and the
 * proposed-harness panel before the terminal event lands.
 */

/** A scan started. Echoes the resolved categories/model for the UI header. */
export const HarnessScanStartedEvent = z.object({
  type: z.literal('harness-scan-started'),
  runId: z.string(),
  categories: z.array(ConventionCategorySchema),
  model: z.string(),
});

/** The deterministic repo profile is ready (emitted before any convention pass). */
export const HarnessProfileReadyEvent = z.object({
  type: z.literal('harness-profile-ready'),
  runId: z.string(),
  profile: RepoProfileSchema,
});

/** A convention pass began exploring (the UI shows skeleton cards for it). */
export const HarnessCategoryStartedEvent = z.object({
  type: z.literal('harness-category-started'),
  runId: z.string(),
  category: ConventionCategorySchema,
});

/** A convention pass finished: its grounded findings stream in as a batch, plus the
 *  pass's own token usage and cost so the UI can show per-lens spend. */
export const HarnessCategoryCompletedEvent = z.object({
  type: z.literal('harness-category-completed'),
  runId: z.string(),
  category: ConventionCategorySchema,
  findings: z.array(ConventionFindingSchema),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): findings is then empty and the
   *  UI marks the lens errored rather than "0 findings". */
  error: z.string().optional(),
});

/** The synthesis pass began (after every convention pass, before proposals).
 *  Carries no payload beyond `runId`: it exists so the UI can show a
 *  "Synthesizing harness…" state instead of a frozen, all-lenses-done dead zone,
 *  and so the Rust/terminal logs mark the start of the (serial) synthesis tail. */
export const HarnessSynthesisStartedEvent = z.object({
  type: z.literal('harness-synthesis-started'),
  runId: z.string(),
});

/** The synthesis pass finished: the proposed harness artifacts stream in as a batch.
 *  Emitted after every convention pass, before the terminal event. */
export const HarnessProposalsReadyEvent = z.object({
  type: z.literal('harness-proposals-ready'),
  runId: z.string(),
  artifacts: z.array(ProposedArtifactSchema),
});

/** The whole scan finished: the final profile, deduped convention findings, and
 *  proposed artifacts plus run totals. The Rust reader persists from THIS event. */
export const HarnessScanCompletedEvent = z.object({
  type: z.literal('harness-scan-completed'),
  runId: z.string(),
  profile: RepoProfileSchema,
  findings: z.array(ConventionFindingSchema),
  artifacts: z.array(ProposedArtifactSchema),
  categoriesRun: z.array(ConventionCategorySchema),
  costUsd: z.number(),
  durationMs: z.number().nonnegative().default(0),
  usage: TokenUsageSchema.optional(),
});

/** The scan failed before completing (could not start, or aborted). Reuses the
 *  same reason set as `analysis-failed` (collapses to one generated Rust enum). */
export const HarnessScanFailedEvent = z.object({
  type: z.literal('harness-scan-failed'),
  runId: z.string(),
  reason: z.enum(['aborted', 'runner-crash', 'unknown']),
  message: z.string(),
});

/**
 * Readiness Scorecard events (the Profile twin of the `analysis-*` family). Like
 * `analysis-*` they carry no `sessionId` and correlate by `runId`; the Rust reader
 * routes the whole `scorecard-*` family to the `nc:scorecard` channel and persists
 * the run on `scorecard-completed`. Each dimension pass emits ONE grounded reading
 * (an A–F grade plus evidence) rather than a batch of severity-ranked findings.
 */

/** A run started. Echoes the resolved dimensions/model for the UI header. */
export const ScorecardStartedEvent = z.object({
  type: z.literal('scorecard-started'),
  runId: z.string(),
  dimensions: z.array(ScorecardDimensionSchema),
  model: z.string(),
});

/** A dimension pass began grading (the UI shows a skeleton row for it). */
export const ScorecardDimensionStartedEvent = z.object({
  type: z.literal('scorecard-dimension-started'),
  runId: z.string(),
  dimension: ScorecardDimensionSchema,
});

/** A dimension pass finished: its single grounded reading streams in, plus the
 *  pass's own token usage and cost so the UI can show per-dimension spend. */
export const ScorecardDimensionCompletedEvent = z.object({
  type: z.literal('scorecard-dimension-completed'),
  runId: z.string(),
  dimension: ScorecardDimensionSchema,
  /** The graded reading; absent when the pass itself failed (parse/abort). */
  reading: ScorecardReadingSchema.optional(),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): `reading` is then absent and the
   *  UI marks the dimension errored rather than "ungraded". */
  error: z.string().optional(),
});

/** The whole run finished: the final per-dimension readings plus run totals. The
 *  Rust reader persists from THIS event (authoritative). */
export const ScorecardCompletedEvent = z.object({
  type: z.literal('scorecard-completed'),
  runId: z.string(),
  readings: z.array(ScorecardReadingSchema),
  dimensionsRun: z.array(ScorecardDimensionSchema),
  costUsd: z.number(),
  durationMs: z.number().nonnegative().default(0),
  usage: TokenUsageSchema.optional(),
});

/** The run failed before completing (could not start, or aborted). Reuses the same
 *  reason set as `analysis-failed` (collapses to one generated Rust enum). */
export const ScorecardFailedEvent = z.object({
  type: z.literal('scorecard-failed'),
  runId: z.string(),
  reason: z.enum(['aborted', 'runner-crash', 'unknown']),
  message: z.string(),
});

/** The discriminated union of every engine → surface event, keyed by `type`. */
export const NightcoreEventSchema = z.discriminatedUnion('type', [
  SessionStartedEvent,
  SessionReadyEvent,
  AssistantDeltaEvent,
  ToolUseRequestedEvent,
  ToolResultEvent,
  PermissionRequiredEvent,
  QuestionRequiredEvent,
  TaskUpdatedEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  SessionStatusEvent,
  QueryResultEvent,
  AnalysisStartedEvent,
  AnalysisCategoryStartedEvent,
  AnalysisCategoryCompletedEvent,
  AnalysisCompletedEvent,
  AnalysisFailedEvent,
  HarnessScanStartedEvent,
  HarnessProfileReadyEvent,
  HarnessCategoryStartedEvent,
  HarnessCategoryCompletedEvent,
  HarnessSynthesisStartedEvent,
  HarnessProposalsReadyEvent,
  HarnessScanCompletedEvent,
  HarnessScanFailedEvent,
  ScorecardStartedEvent,
  ScorecardDimensionStartedEvent,
  ScorecardDimensionCompletedEvent,
  ScorecardCompletedEvent,
  ScorecardFailedEvent,
]);
export type NightcoreEvent = z.infer<typeof NightcoreEventSchema>;

/** Convenience map from event `type` to its inferred TS shape. */
export type NightcoreEventOf<T extends NightcoreEvent['type']> = Extract<
  NightcoreEvent,
  { type: T }
>;
