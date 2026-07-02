/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

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
