/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { NightcoreEvent } from '@nightcore/contracts';
import {
  mapAssistantError,
  translateMessage,
  type SDKMessage,
} from './sdk-adapter.js';

const SID = 7;

/** Minimal SDK message fixtures. `translateMessage` is defensive and reads only
 *  a handful of fields, so we cast partial shapes through `unknown`. */
function sdk(msg: Record<string, unknown>): SDKMessage {
  return msg as unknown as SDKMessage;
}

describe('translateMessage — system init', () => {
  test('emits session-ready and surfaces the SDK session id', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-uuid-1',
        model: 'claude-opus-4-8',
        tools: ['Read', 'Bash'],
      }),
    );
    expect(result.sdkSessionId).toBe('sdk-uuid-1');
    expect(result.events).toEqual([
      {
        type: 'session-ready',
        sessionId: SID,
        sdkSessionId: 'sdk-uuid-1',
        model: 'claude-opus-4-8',
        tools: ['Read', 'Bash'],
        slashCommands: [],
        skills: [],
      },
    ]);
  });

  test('surfaces slash_commands and skills from the init message', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-uuid-2',
        model: 'claude-opus-4-8',
        tools: ['Read'],
        slash_commands: ['compact', 'context'],
        skills: ['pdf'],
      }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-ready' }
    >;
    expect(event.slashCommands).toEqual(['compact', 'context']);
    expect(event.skills).toEqual(['pdf']);
  });

  test('ignores non-init system subtypes', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'system', subtype: 'compact_boundary' }),
    );
    expect(result.events).toEqual([]);
    expect(result.sdkSessionId).toBeUndefined();
  });
});

describe('translateMessage — task lifecycle system messages', () => {
  test('maps task_started to a running task-updated (ambient from skip_transcript)', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Investigating the auth flow',
        subagent_type: 'Explore',
        skip_transcript: true,
      }),
    );
    expect(result.terminal).toBeUndefined();
    expect(result.events).toEqual([
      {
        type: 'task-updated',
        sessionId: SID,
        taskId: 'task-1',
        status: 'running',
        description: 'Investigating the auth flow',
        subagentType: 'Explore',
        ambient: true,
      },
    ]);
  });

  test('defaults ambient to false when skip_transcript is absent', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'system', subtype: 'task_started', task_id: 'task-2', description: 'go' }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'task-updated' }
    >;
    expect(event.ambient).toBe(false);
    expect(event.subagentType).toBeUndefined();
  });

  test('maps task_updated patch (status + error → summary)', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-3',
        patch: { status: 'failed', description: 'retrying', error: 'boom' },
      }),
    );
    expect(result.events).toEqual([
      {
        type: 'task-updated',
        sessionId: SID,
        taskId: 'task-3',
        status: 'failed',
        description: 'retrying',
        summary: 'boom',
        ambient: false,
      },
    ]);
  });

  test('maps task_progress (description + summary + subagent, no status)', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-4',
        description: 'still working',
        summary: 'half done',
        subagent_type: 'builder',
      }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'task-updated' }
    >;
    expect(event.status).toBeUndefined();
    expect(event).toMatchObject({
      taskId: 'task-4',
      description: 'still working',
      summary: 'half done',
      subagentType: 'builder',
      ambient: false,
    });
  });

  test('maps task_notification stopped → killed', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-5',
        status: 'stopped',
        summary: 'user cancelled',
      }),
    );
    expect(result.events).toEqual([
      {
        type: 'task-updated',
        sessionId: SID,
        taskId: 'task-5',
        status: 'killed',
        summary: 'user cancelled',
        ambient: false,
      },
    ]);
  });

  test('maps task_notification completed as-is', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-6',
        status: 'completed',
        summary: 'done',
      }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'task-updated' }
    >;
    expect(event.status).toBe('completed');
  });

  test('ignores a task subtype with no task_id', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'system', subtype: 'task_progress', description: 'orphan' }),
    );
    expect(result.events).toEqual([]);
  });
});

describe('translateMessage — assistant message blocks', () => {
  test('maps a text block to a non-partial assistant-delta', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }),
    );
    expect(result.events).toEqual([
      { type: 'assistant-delta', sessionId: SID, text: 'hello world', partial: false },
    ]);
  });

  test('drops empty text blocks', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }),
    );
    expect(result.events).toEqual([]);
  });

  test('maps a tool_use block to tool-use-requested', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    );
    expect(result.events).toEqual([
      {
        type: 'tool-use-requested',
        sessionId: SID,
        toolUseId: 'tu_1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    ]);
  });

  test('defaults missing tool input to an empty object', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read' }] },
      }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'tool-use-requested' }
    >;
    expect(event.input).toEqual({});
  });

  test('emits multiple events in order for a mixed-block message', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 'tu_3', name: 'Grep', input: { q: 'x' } },
          ],
        },
      }),
    );
    expect(result.events.map((e) => e.type)).toEqual([
      'assistant-delta',
      'tool-use-requested',
    ]);
  });

  test('tolerates a non-array content payload', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'assistant', message: { content: 'a bare string' } }),
    );
    expect(result.events).toEqual([]);
  });
});

describe('translateMessage — stream events', () => {
  test('maps a text_delta to a partial assistant-delta', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk' } },
      }),
    );
    expect(result.events).toEqual([
      { type: 'assistant-delta', sessionId: SID, text: 'chunk', partial: true },
    ]);
  });

  test('ignores empty text deltas', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      }),
    );
    expect(result.events).toEqual([]);
  });

  test('ignores unrelated stream events', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'stream_event', event: { type: 'message_start' } }),
    );
    expect(result.events).toEqual([]);
  });
});

describe('translateMessage — result (terminal)', () => {
  test('maps a success result to session-completed and a completed terminal', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'all done',
        total_cost_usd: 0.42,
        num_turns: 5,
        duration_ms: 1234,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      }),
    );
    expect(result.events).toEqual([
      {
        type: 'session-completed',
        sessionId: SID,
        result: 'all done',
        costUsd: 0.42,
        numTurns: 5,
        durationMs: 1234,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
        },
      },
    ]);
    expect(result.terminal).toEqual({
      kind: 'completed',
      result: 'all done',
      costUsd: 0.42,
      numTurns: 5,
    });
  });

  test('decompose kind threads parsed proposedSubtasks onto session-completed', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'Plan:\n```json\n[{"title":"A","prompt":"do a"}]\n```',
        total_cost_usd: 0.1,
        num_turns: 2,
        duration_ms: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { kind: 'decompose' },
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-completed' }
    >;
    expect(event.type).toBe('session-completed');
    expect(event.proposedSubtasks).toEqual([{ title: 'A', prompt: 'do a' }]);
  });

  test('decompose with no parseable array yields an empty proposedSubtasks', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'I could not decompose this goal.',
        total_cost_usd: 0,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      { kind: 'decompose' },
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-completed' }
    >;
    expect(event.proposedSubtasks).toEqual([]);
  });

  test('non-decompose kinds omit proposedSubtasks entirely', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'result',
        subtype: 'success',
        result: '[{"title":"A","prompt":"do a"}]',
        total_cost_usd: 0,
        num_turns: 1,
        duration_ms: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      { kind: 'build' },
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-completed' }
    >;
    expect('proposedSubtasks' in event).toBe(false);
  });

  test('maps error_max_turns to a max-turns failure', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'result', subtype: 'error_max_turns', errors: ['hit the cap'] }),
    );
    expect(result.events).toEqual([
      { type: 'session-failed', sessionId: SID, reason: 'max-turns', message: 'hit the cap' },
    ]);
    expect(result.terminal).toEqual({
      kind: 'failed',
      reason: 'max-turns',
      message: 'hit the cap',
    });
  });

  test('maps error_max_budget_usd to a max-budget failure', () => {
    const result = translateMessage(
      SID,
      sdk({
        type: 'result',
        subtype: 'error_max_budget_usd',
        errors: ['budget exceeded'],
      }),
    );
    expect(result.events).toEqual([
      {
        type: 'session-failed',
        sessionId: SID,
        reason: 'max-budget',
        message: 'budget exceeded',
      },
    ]);
    expect(result.terminal).toEqual({
      kind: 'failed',
      reason: 'max-budget',
      message: 'budget exceeded',
    });
  });

  test('maps a generic execution error to an unknown failure', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'result', subtype: 'error_during_execution', errors: [] }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-failed' }
    >;
    expect(event.reason).toBe('unknown');
    // Empty errors array falls back to the subtype as the message.
    expect(event.message).toBe('error_during_execution');
  });

  test('joins multiple error strings into one message', () => {
    const result = translateMessage(
      SID,
      sdk({ type: 'result', subtype: 'error_during_execution', errors: ['a', 'b'] }),
    );
    const event = result.events[0] as Extract<
      NightcoreEvent,
      { type: 'session-failed' }
    >;
    expect(event.message).toBe('a; b');
  });
});

describe('translateMessage — unknown message types', () => {
  test('returns no events for an unhandled type', () => {
    const result = translateMessage(SID, sdk({ type: 'auth_status' }));
    expect(result.events).toEqual([]);
    expect(result.terminal).toBeUndefined();
  });
});

describe('mapAssistantError', () => {
  type Reason = ReturnType<typeof mapAssistantError>;
  const cases: ReadonlyArray<readonly [string | undefined, Reason]> = [
    ['authentication_failed', 'authentication'],
    ['oauth_org_not_allowed', 'authentication'],
    ['rate_limit', 'rate-limit'],
    ['overloaded', 'rate-limit'],
    ['max_output_tokens', 'max-turns'],
    ['server_error', 'unknown'],
    [undefined, 'unknown'],
  ];
  test.each(cases)('maps %p to %p', (input, expected) => {
    expect(mapAssistantError(input)).toBe(expected);
  });
});
