import type {
  CodexOptions,
  Input,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
} from '@openai/codex-sdk';
import { Codex } from '@openai/codex-sdk';

import type { NightcoreEvent, TaskKind } from '@nightcore/contracts';

import {
  parseSubtasks,
  subtasksFromStructuredOutput,
} from '../claude/decompose.js';

export type {
  ApprovalMode,
  CodexOptions,
  Input,
  ModelReasoningEffort,
  SandboxMode,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage,
} from '@openai/codex-sdk';
export { Codex };

/** The minimal Codex SDK surface a session drives — a seam so tests can fake the turn
 *  loop (follow-up delivery, reviewer read-only posture) without spawning `codex
 *  exec`. The real {@link Codex} class satisfies it; a `Thread.runStreamed` returns a
 *  `StreamedTurn` whose `events` is an `AsyncGenerator` (an `AsyncIterable`). */
export interface CodexThreadLike {
  runStreamed(
    input: Input,
    turnOptions?: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}
export type CodexFactory = (options: CodexOptions) => CodexLike;

/** The production factory: the real `@openai/codex-sdk` client. */
export const defaultCodexFactory: CodexFactory = (options) => new Codex(options);

type FailureReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

export interface CodexTranslationState {
  readonly sessionId: number;
  readonly model: string;
  readonly kind?: TaskKind;
  readonly startedAt: number;
  turnCount: number;
  finalResponse: string;
  structuredOutput?: unknown;
}

export function createCodexTranslationState(opts: {
  sessionId: number;
  model: string;
  kind?: TaskKind;
  startedAt?: number;
}): CodexTranslationState {
  return {
    sessionId: opts.sessionId,
    model: opts.model,
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    startedAt: opts.startedAt ?? Date.now(),
    turnCount: 0,
    finalResponse: '',
  };
}

export function translateCodexEvent(
  event: ThreadEvent,
  state: CodexTranslationState,
): { events: NightcoreEvent[]; terminal?: true } {
  switch (event.type) {
    case 'thread.started':
      return {
        events: [
          {
            type: 'session-ready',
            sessionId: state.sessionId,
            sdkSessionId: event.thread_id,
            model: state.model,
            tools: [],
            slashCommands: [],
            skills: [],
          },
        ],
      };
    case 'turn.started':
      state.turnCount += 1;
      return { events: [] };
    case 'item.started':
      return { events: translateItem(event.item, state, 'started') };
    case 'item.updated':
      return { events: translateItem(event.item, state, 'updated') };
    case 'item.completed':
      return { events: translateItem(event.item, state, 'completed') };
    case 'turn.completed':
      return {
        events: [
          {
            type: 'session-completed',
            sessionId: state.sessionId,
            result: state.finalResponse,
            numTurns: Math.max(state.turnCount, 1),
            durationMs: Date.now() - state.startedAt,
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cacheReadTokens: event.usage.cached_input_tokens,
              cacheCreationTokens: 0,
              reasoningOutputTokens: event.usage.reasoning_output_tokens,
            },
            ...(state.kind === 'decompose'
              ? {
                  proposedSubtasks:
                    subtasksFromStructuredOutput(state.structuredOutput) ??
                    parseSubtasks(state.finalResponse),
                }
              : {}),
          },
        ],
        terminal: true,
      };
    case 'turn.failed':
      return {
        events: [failed(state.sessionId, 'unknown', event.error.message)],
        terminal: true,
      };
    case 'error':
      return {
        events: [failed(state.sessionId, 'runner-crash', event.message)],
        terminal: true,
      };
  }
}

function translateItem(
  item: ThreadItem,
  state: CodexTranslationState,
  phase: 'started' | 'updated' | 'completed',
): NightcoreEvent[] {
  switch (item.type) {
    case 'agent_message':
      state.finalResponse = item.text;
      if (item.text.length === 0) return [];
      return [
        {
          type: 'assistant-delta',
          sessionId: state.sessionId,
          text: item.text,
          partial: phase !== 'completed',
        },
      ];
    case 'reasoning':
      return item.text.length > 0
        ? [
            {
              type: 'assistant-delta',
              sessionId: state.sessionId,
              text: item.text,
              partial: phase !== 'completed',
            },
          ]
        : [];
    case 'command_execution':
      if (phase === 'started') {
        return [
          {
            type: 'tool-use-requested',
            sessionId: state.sessionId,
            toolUseId: item.id,
            toolName: 'command_execution',
            input: { command: item.command },
          },
        ];
      }
      if (phase !== 'completed') return [];
      return [
        {
          type: 'tool-result',
          sessionId: state.sessionId,
          toolUseId: item.id,
          isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
          content: item.aggregated_output,
        },
      ];
    case 'mcp_tool_call':
      if (phase === 'started') {
        return [
          {
            type: 'tool-use-requested',
            sessionId: state.sessionId,
            toolUseId: item.id,
            toolName: `mcp:${item.server}/${item.tool}`,
            input:
              typeof item.arguments === 'object' && item.arguments !== null
                ? (item.arguments as Record<string, unknown>)
                : { arguments: item.arguments },
          },
        ];
      }
      if (phase !== 'completed') return [];
      return [
        {
          type: 'tool-result',
          sessionId: state.sessionId,
          toolUseId: item.id,
          isError: item.status === 'failed',
          content:
            item.error?.message ??
            (item.result !== undefined ? JSON.stringify(item.result) : ''),
        },
      ];
    case 'todo_list':
      return item.items.map((todo, index) => ({
        type: 'task-updated',
        sessionId: state.sessionId,
        taskId: `${item.id}:${index}`,
        status: todo.completed ? 'completed' : 'running',
        description: todo.text,
        ambient: false,
      }));
    case 'error':
      return [failed(state.sessionId, 'unknown', item.message)];
    case 'file_change':
    case 'web_search':
      return [];
  }
}

function failed(
  sessionId: number,
  reason: FailureReason,
  message: string,
): Extract<NightcoreEvent, { type: 'session-failed' }> {
  return { type: 'session-failed', sessionId, reason, message };
}
