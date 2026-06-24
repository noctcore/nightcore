import { z } from 'zod';
import { PermissionModeSchema } from './config.js';
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

export const NightcoreEventSchema = z.discriminatedUnion('type', [
  SessionStartedEvent,
  SessionReadyEvent,
  AssistantDeltaEvent,
  ToolUseRequestedEvent,
  ToolResultEvent,
  PermissionRequiredEvent,
  TaskUpdatedEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  SessionStatusEvent,
  QueryResultEvent,
]);
export type NightcoreEvent = z.infer<typeof NightcoreEventSchema>;

/** Convenience map from event `type` to its inferred TS shape. */
export type NightcoreEventOf<T extends NightcoreEvent['type']> = Extract<
  NightcoreEvent,
  { type: T }
>;
