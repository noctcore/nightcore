/**
 * The single boundary file where the Claude Agent SDK is imported broadly. The
 * rest of the engine speaks `NightcoreEvent` / contract types; only this module
 * knows the SDK's `SDKMessage` shapes. Centralizing the import keeps the SDK API
 * surface (which drifts across versions) confined to one place.
 */
import type {
  AgentDefinition,
  AgentInfo,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  Options,
  OutputFormat,
  PermissionMode,
  Query,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SessionMutationOptions,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk';

import type { NightcoreEvent, TaskKind } from '@nightcore/contracts';

import { asStructuredOutput } from '../../util/json-extract.js';
import { parseSubtasks, subtasksFromStructuredOutput } from './decompose.js';
import {
  detailForReason,
  mapAssistantError,
  type NightcoreEventOfReason,
} from './sdk-error-classification.js';
import { translateTask } from './sdk-task-events.js';

export type {
  AgentDefinition,
  AgentInfo,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  Options,
  OutputFormat,
  PermissionMode,
  Query,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SessionMutationOptions,
  SlashCommand,
};
export {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
};
export {
  categoryForReason,
  detailForReason,
  mapAssistantError,
} from './sdk-error-classification.js';

/** A minimal text content block. */
interface TextBlock {
  type: 'text';
  text: string;
}
/** A minimal tool_use content block. `input` is left `unknown` because the guard
 *  cannot soundly assert its shape; the consumer normalizes it to a record. */
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as { type?: unknown; id?: unknown; name?: unknown };
  // The `tool-use-requested` contract requires string `toolUseId`/`toolName`; the
  // old guard only checked `type`, so a block missing id/name produced an invalid
  // event. Verify both so the `block is ToolUseBlock` assertion is sound.
  return b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string';
}

/**
 * Translate one raw `SDKMessage` into zero or more `NightcoreEvent`s for a given
 * Nightcore session id. Returns the events plus optional side-channel signals
 * (the SDK session id from `init`, terminal result data) the runner acts on.
 *
 * This is intentionally pure and synchronous so it is trivially unit-testable
 * without spawning the SDK.
 */
export function translateMessage(
  sessionId: number,
  msg: SDKMessage,
  options: TranslateOptions = {},
): TranslateResult {
  switch (msg.type) {
    case 'system':
      return translateSystem(sessionId, msg);
    case 'assistant':
      return { events: translateAssistant(sessionId, msg) };
    case 'stream_event':
      return { events: translateStreamEvent(sessionId, msg) };
    case 'result':
      return translateResult(sessionId, msg, options);
    default:
      // Many SDK message subtypes (status, hooks, task progress, etc.) carry no
      // surface-relevant payload for the foundation — ignore them.
      return { events: [] };
  }
}

/** Per-session context the translator needs beyond the raw SDK message. */
export interface TranslateOptions {
  /** The session's task kind. When `'decompose'`, a successful result's final text
   *  is parsed into `proposedSubtasks` on the emitted `session-completed` event;
   *  for every other kind (or when absent) that field is omitted. */
  kind?: TaskKind;
  /** The most recent `SDKAssistantMessageError` seen on the stream, if any. The
   *  SDK's terminal `result` message does not carry the assistant-level error, so
   *  the runner threads it here; a non-ceiling failure reason is refined from it
   *  (auth / rate-limit / …) instead of collapsing to `'unknown'`. */
  assistantError?: string;
}

export interface TranslateResult {
  events: NightcoreEvent[];
  /** Set when the SDK emits its `init` system message. */
  sdkSessionId?: string;
  /** Set on a terminal `result` message. */
  terminal?:
    | { kind: 'completed'; result: string; costUsd: number; numTurns: number }
    | { kind: 'failed'; reason: NightcoreEventOfReason; message: string };
}

function translateSystem(
  sessionId: number,
  msg: Extract<SDKMessage, { type: 'system' }>,
): TranslateResult {
  if (msg.subtype === 'init') {
    return {
      events: [
        {
          type: 'session-ready',
          sessionId,
          sdkSessionId: msg.session_id,
          model: msg.model,
          tools: msg.tools,
          slashCommands: msg.slash_commands ?? [],
          skills: msg.skills ?? [],
        },
      ],
      sdkSessionId: msg.session_id,
    };
  }

  const task = translateTask(sessionId, msg);
  if (task) return { events: [task] };

  return { events: [] };
}

function translateAssistant(
  sessionId: number,
  msg: Extract<SDKMessage, { type: 'assistant' }>,
): NightcoreEvent[] {
  const events: NightcoreEvent[] = [];
  const content = (msg.message as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];

  for (const block of blocks) {
    if (isTextBlock(block) && block.text.length > 0) {
      events.push({
        type: 'assistant-delta',
        sessionId,
        text: block.text,
        partial: false,
      });
    } else if (isToolUseBlock(block)) {
      events.push({
        type: 'tool-use-requested',
        sessionId,
        toolUseId: block.id,
        toolName: block.name,
        // Normalize a non-object/absent input to {} (the guard no longer asserts it).
        input:
          typeof block.input === 'object' && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return events;
}

function translateStreamEvent(
  sessionId: number,
  msg: Extract<SDKMessage, { type: 'stream_event' }>,
): NightcoreEvent[] {
  const event = msg.event as {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string' &&
    event.delta.text.length > 0
  ) {
    return [
      {
        type: 'assistant-delta',
        sessionId,
        text: event.delta.text,
        partial: true,
      },
    ];
  }
  return [];
}

function translateResult(
  sessionId: number,
  msg: Extract<SDKMessage, { type: 'result' }>,
  options: TranslateOptions,
): TranslateResult {
  if (msg.subtype === 'success') {
    // The SDK's native structured output, forwarded verbatim (object-wrapped) for any
    // kind that set `outputFormat` (pr-review reads its passes off this; decompose below).
    const structuredOutput = asStructuredOutput(msg.structured_output);
    return {
      events: [
        {
          type: 'session-completed',
          sessionId,
          result: msg.result,
          costUsd: msg.total_cost_usd,
          numTurns: msg.num_turns,
          durationMs: msg.duration_ms,
          usage: {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
            reasoningOutputTokens: 0,
          },
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          // Decompose additionally parses its `{ subtasks }` into validated
          // `proposedSubtasks` (native structured output preferred, text fallback);
          // omitted for every other kind.
          ...(options.kind === 'decompose'
            ? {
                proposedSubtasks:
                  subtasksFromStructuredOutput(msg.structured_output) ??
                  parseSubtasks(msg.result),
              }
            : {}),
        },
      ],
      terminal: {
        kind: 'completed',
        result: msg.result,
        costUsd: msg.total_cost_usd,
        numTurns: msg.num_turns,
      },
    };
  }

  // An autonomy-ceiling / contract-failure stop is a terminal, needs-attention
  // outcome — not a silent success. The SDK result subtype carries which one was
  // hit: `error_max_turns` (turn guard) / `error_max_budget_usd` (cost guard) /
  // `error_max_structured_output_retries` (the SDK exhausted its internal retries
  // trying to make the output conform to the requested `outputFormat` schema — a
  // decompose run that never produced a valid `{ subtasks }` object). Each
  // surfaces as a distinct `session-failed` reason the web can park on rather
  // than treating as a verified pass with an empty proposal list. For every other
  // error subtype (`error_during_execution`, …) the result message carries no
  // reason, so we refine from the last assistant-level error the runner threaded
  // in — an auth/rate-limit stall must not collapse to an indistinct `'unknown'`.
  const reason: NightcoreEventOfReason =
    msg.subtype === 'error_max_turns'
      ? 'max-turns'
      : msg.subtype === 'error_max_budget_usd'
        ? 'max-budget'
        : msg.subtype === 'error_max_structured_output_retries'
          ? 'structured-output-failed'
          : mapAssistantError(options.assistantError);
  const message = msg.errors.join('; ') || msg.subtype;
  return {
    events: [
      {
        type: 'session-failed',
        sessionId,
        reason,
        message,
        detail: detailForReason(reason, message),
      },
    ],
    terminal: { kind: 'failed', reason, message },
  };
}
