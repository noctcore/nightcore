/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { type NightcoreEvent,NightcoreEventSchema } from './events.js';

describe('NightcoreEventSchema round-trips', () => {
  const valid: NightcoreEvent[] = [
    {
      type: 'session-started',
      sessionId: 1,
      prompt: 'hello',
      model: 'claude-opus-4-8',
      permissionMode: 'default',
    },
    // A council SEAT session-started carries the `council` marker (issue #364) — the
    // signal the Rust reader uses to skip board-FIFO correlation for the seat.
    {
      type: 'session-started',
      sessionId: 209,
      prompt: 'debate',
      model: 'claude-opus-4-8',
      permissionMode: 'plan',
      council: true,
    },
    {
      type: 'session-ready',
      sessionId: 1,
      sdkSessionId: 'uuid-abc',
      model: 'claude-opus-4-8',
      tools: ['Read', 'Bash'],
      slashCommands: [],
      skills: [],
    },
    { type: 'assistant-delta', sessionId: 2, text: 'partial', partial: true },
    {
      type: 'tool-use-requested',
      sessionId: 3,
      toolUseId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
    },
    {
      type: 'permission-required',
      sessionId: 4,
      requestId: 'req_1',
      toolName: 'Write',
      input: { path: '/tmp/x' },
    },
    {
      type: 'question-required',
      sessionId: 4,
      requestId: 'q_req_1',
      toolUseId: 'tu_aq_1',
      questions: [
        {
          question: 'Which auth method should we use?',
          header: 'Auth method',
          options: [
            {
              label: 'OAuth',
              description: 'Delegate to an identity provider.',
              preview: '```ts\nawait oauth()\n```',
            },
            { label: 'JWT', description: 'Self-issued signed tokens.' },
          ],
          multiSelect: false,
        },
      ],
    },
    {
      type: 'task-updated',
      sessionId: 5,
      taskId: 'task_1',
      status: 'running',
      description: 'exploring the codebase',
      ambient: false,
    },
    {
      type: 'session-completed',
      sessionId: 5,
      result: 'ok',
      costUsd: 0.1,
      numTurns: 3,
      durationMs: 1200,
    },
    {
      type: 'session-failed',
      sessionId: 6,
      reason: 'rate-limit',
      message: 'slow down',
    },
    { type: 'session-status', sessionId: 7, status: 'running' },
    {
      type: 'query-result',
      requestId: 'q1',
      ok: true,
      kind: 'sessions',
      sessions: [
        {
          sdkSessionId: 'uuid-1',
          summary: 'Add the resume UX',
          lastModified: 1718900000000,
          gitBranch: 'nc/task-1',
          cwd: '/proj/.nightcore/worktrees/task-1',
          tag: 'keep',
          createdAt: 1718800000000,
        },
      ],
    },
    {
      type: 'query-result',
      requestId: 'q2',
      ok: true,
      kind: 'session-info',
      info: {
        sdkSessionId: 'uuid-2',
        summary: 'A run',
        lastModified: 1718900000000,
      },
    },
    {
      type: 'query-result',
      requestId: 'q3',
      ok: true,
      kind: 'session-info',
      info: null,
    },
    {
      type: 'query-result',
      requestId: 'q4',
      ok: true,
      kind: 'messages',
      messages: [
        {
          type: 'assistant',
          uuid: 'm-1',
          sessionId: 'uuid-3',
          message: { role: 'assistant', content: 'hi' },
          parentToolUseId: null,
        },
      ],
    },
    { type: 'query-result', requestId: 'q5', ok: true, kind: 'ack' },
    {
      type: 'query-result',
      requestId: 'q6',
      ok: false,
      kind: 'sessions',
      error: 'session store unavailable',
    },
    {
      type: 'query-result',
      requestId: 'q7',
      ok: true,
      kind: 'provider-config',
      providerConfig: {
        providerId: 'claude',
        providerLabel: 'Claude',
        projectPath: '/proj',
        mcp: {
          status: 'supported',
          mcpServers: [
            {
              name: 'github',
              status: 'connected',
              scope: 'project',
              transport: 'stdio',
              toolCount: 12,
            },
          ],
        },
        skills: { status: 'supported', skills: [{ name: 'add-feature' }] },
        subagents: {
          status: 'supported',
          subagents: [{ name: 'Explore', description: 'read-only search' }],
        },
        model: 'claude-opus-4-8',
        permissionMode: 'acceptEdits',
        outputStyle: 'default',
        extrasStatus: 'supported',
      },
    },
    {
      type: 'query-result',
      requestId: 'q8',
      ok: true,
      kind: 'provider-config',
      providerConfig: {
        providerId: 'codex',
        providerLabel: 'Codex',
        projectPath: '/proj',
        mcp: { status: 'unsupported' },
        skills: { status: 'unsupported' },
        subagents: { status: 'unavailable', error: 'probe timed out' },
        extrasStatus: 'unsupported',
      },
    },
  ];

  for (const event of valid) {
    test(`accepts and preserves a ${event.type} event`, () => {
      const parsed = NightcoreEventSchema.parse(event);
      expect(parsed).toEqual(event);
    });
  }
});

describe('session telemetry additive defaults', () => {
  test('session-completed accepts token-only providers with absent costUsd', () => {
    const parsed = NightcoreEventSchema.parse({
      type: 'session-completed',
      sessionId: 9,
      result: 'ok',
      numTurns: 1,
      durationMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 3,
      },
    });
    expect(parsed.type).toBe('session-completed');
    if (parsed.type === 'session-completed') {
      expect(parsed.costUsd).toBeUndefined();
    }
  });

  test('token usage defaults absent reasoning output tokens to zero', () => {
    const parsed = NightcoreEventSchema.parse({
      type: 'session-completed',
      sessionId: 9,
      result: 'ok',
      numTurns: 1,
      durationMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(parsed.type).toBe('session-completed');
    if (parsed.type === 'session-completed') {
      expect(parsed.usage?.reasoningOutputTokens).toBe(0);
    }
  });
});

describe('NightcoreEventSchema rejections', () => {
  test('rejects an unknown discriminant', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'not-a-real-event',
      sessionId: 1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects a negative sessionId', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-status',
      sessionId: -1,
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a non-integer sessionId', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-status',
      sessionId: 1.5,
      status: 'running',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a session-failed event with an unlisted reason', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-failed',
      sessionId: 1,
      reason: 'meltdown',
      message: 'x',
    });
    expect(result.success).toBe(false);
  });

  test('accepts the structured-output-failed reason (SDK structured-output retries exhausted)', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-failed',
      sessionId: 1,
      reason: 'structured-output-failed',
      message: 'output never matched the schema',
    });
    expect(result.success).toBe(true);
  });

  test('rejects a session-status event with an unknown status', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-status',
      sessionId: 1,
      status: 'vibing',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a session-started event missing required fields', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-started',
      sessionId: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('session-failed structured ErrorDetail (additive)', () => {
  test('accepts and preserves a structured detail alongside reason/message', () => {
    const event = {
      type: 'session-failed',
      sessionId: 9,
      reason: 'authentication',
      message: 'auth failed',
      detail: { category: 'auth', message: 'auth failed', retriable: false },
    } satisfies NightcoreEvent;
    const parsed = NightcoreEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  test('stays backward-compatible when detail is omitted', () => {
    const parsed = NightcoreEventSchema.parse({
      type: 'session-failed',
      sessionId: 9,
      reason: 'rate-limit',
      message: 'slow down',
    });
    expect(parsed).toEqual({
      type: 'session-failed',
      sessionId: 9,
      reason: 'rate-limit',
      message: 'slow down',
    });
  });

  test('rejects a detail with an unlisted category', () => {
    const result = NightcoreEventSchema.safeParse({
      type: 'session-failed',
      sessionId: 9,
      reason: 'unknown',
      message: 'x',
      detail: { category: 'meltdown', message: 'x', retriable: false },
    });
    expect(result.success).toBe(false);
  });
});

describe('union-membership guard — every exported *Event is registered', () => {
  const unionTypes = new Set<string>(
    NightcoreEventSchema.options.map(
      (option) => (option.shape.type as z.ZodLiteral<string>).value,
    ),
  );

  /** Names of exported `*Event` zod objects whose `type` literal is NOT a member
   *  of `NightcoreEventSchema`'s union. An unregistered event schema is silently
   *  unreachable on the wire — the codegen full-coverage assert only checks
   *  members that ARE in the union, so this is the missing direction. */
  function unregisteredEvents(exports: Record<string, unknown>): string[] {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Event')) continue;
      if (!(value instanceof z.ZodObject)) continue;
      const typeField = (value.shape as Record<string, unknown>).type;
      if (!(typeField instanceof z.ZodLiteral)) continue;
      if (!unionTypes.has(typeField.value as string)) missing.push(name);
    }
    return missing;
  }

  test('every *Event schema exported from the barrel appears in the union', async () => {
    const barrel = (await import('./index.js')) as Record<string, unknown>;
    expect(unregisteredEvents(barrel)).toEqual([]);
  });

  test('the guard goes red on a synthetic unregistered event', () => {
    const RogueEvent = z.object({
      type: z.literal('rogue-event'),
      runId: z.string(),
    });
    expect(unregisteredEvents({ RogueEvent })).toEqual(['RogueEvent']);
  });
});
