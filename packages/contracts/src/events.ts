import { z } from 'zod';
import { PermissionModeSchema } from './config.js';
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
]);
export type NightcoreEvent = z.infer<typeof NightcoreEventSchema>;

/** Convenience map from event `type` to its inferred TS shape. */
export type NightcoreEventOf<T extends NightcoreEvent['type']> = Extract<
  NightcoreEvent,
  { type: T }
>;
