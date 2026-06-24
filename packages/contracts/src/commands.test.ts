/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  SurfaceCommandSchema,
  SurfaceQuerySchema,
  type SurfaceCommand,
  type SurfaceQuery,
} from './commands.js';

describe('SurfaceCommandSchema round-trips', () => {
  const valid: SurfaceCommand[] = [
    { type: 'start-session', prompt: 'do a thing' },
    {
      type: 'start-session',
      prompt: 'do a thing',
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      cwd: '/work',
    },
    {
      type: 'start-session',
      prompt: 'bounded + resumed',
      maxTurns: 50,
      maxBudgetUsd: 3.25,
      resumeSessionId: 'sdk-uuid-prior',
    },
    { type: 'send-input', sessionId: 1, text: 'more' },
    { type: 'interrupt', sessionId: 1 },
    { type: 'set-model', sessionId: 1, model: 'claude-haiku-4-5' },
    { type: 'set-permission-mode', sessionId: 1, mode: 'plan' },
    {
      type: 'approve-permission',
      sessionId: 1,
      requestId: 'req_1',
      decision: { behavior: 'allow' },
    },
    {
      type: 'approve-permission',
      sessionId: 1,
      requestId: 'req_2',
      decision: { behavior: 'deny', message: 'no' },
    },
  ];

  for (const command of valid) {
    test(`accepts and preserves a ${command.type} command`, () => {
      const parsed = SurfaceCommandSchema.parse(command);
      expect(parsed).toEqual(command);
    });
  }
});

describe('SurfaceCommandSchema rejections', () => {
  test('rejects an unknown discriminant', () => {
    const result = SurfaceCommandSchema.safeParse({ type: 'nope' });
    expect(result.success).toBe(false);
  });

  test('rejects a start-session missing its prompt', () => {
    const result = SurfaceCommandSchema.safeParse({ type: 'start-session' });
    expect(result.success).toBe(false);
  });

  test('rejects a start-session with an invalid permission mode', () => {
    const result = SurfaceCommandSchema.safeParse({
      type: 'start-session',
      prompt: 'x',
      permissionMode: 'yolo',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a targeted command without a sessionId', () => {
    const result = SurfaceCommandSchema.safeParse({
      type: 'send-input',
      text: 'hi',
    });
    expect(result.success).toBe(false);
  });

  test('rejects an approve-permission with a malformed decision', () => {
    const result = SurfaceCommandSchema.safeParse({
      type: 'approve-permission',
      sessionId: 1,
      requestId: 'req_1',
      decision: { behavior: 'maybe' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects a deny decision missing its message', () => {
    const result = SurfaceCommandSchema.safeParse({
      type: 'approve-permission',
      sessionId: 1,
      requestId: 'req_1',
      decision: { behavior: 'deny' },
    });
    expect(result.success).toBe(false);
  });
});

describe('SurfaceQuerySchema round-trips', () => {
  const valid: SurfaceQuery[] = [
    { type: 'list-sessions', requestId: 'q1' },
    {
      type: 'list-sessions',
      requestId: 'q2',
      dir: '/proj',
      limit: 20,
      offset: 0,
      includeWorktrees: true,
    },
    { type: 'get-session-info', requestId: 'q3', sdkSessionId: 'uuid-a' },
    {
      type: 'get-session-info',
      requestId: 'q4',
      sdkSessionId: 'uuid-a',
      dir: '/proj',
    },
    { type: 'get-session-messages', requestId: 'q5', sdkSessionId: 'uuid-b' },
    {
      type: 'get-session-messages',
      requestId: 'q6',
      sdkSessionId: 'uuid-b',
      limit: 100,
      offset: 10,
      includeSystemMessages: true,
    },
    {
      type: 'rename-session',
      requestId: 'q7',
      sdkSessionId: 'uuid-c',
      title: 'Refactor pass',
    },
    {
      type: 'tag-session',
      requestId: 'q8',
      sdkSessionId: 'uuid-d',
      tag: 'keep',
    },
    {
      type: 'tag-session',
      requestId: 'q9',
      sdkSessionId: 'uuid-d',
      tag: null,
    },
    { type: 'get-provider-config', requestId: 'q10' },
    { type: 'get-provider-config', requestId: 'q11', dir: '/proj' },
  ];

  for (const query of valid) {
    test(`accepts and preserves a ${query.type} query`, () => {
      const parsed = SurfaceQuerySchema.parse(query);
      expect(parsed).toEqual(query);
    });
  }
});

describe('SurfaceQuerySchema rejections', () => {
  test('rejects an unknown discriminant', () => {
    expect(SurfaceQuerySchema.safeParse({ type: 'nope', requestId: 'x' }).success).toBe(
      false,
    );
  });

  test('rejects a query missing its requestId', () => {
    expect(SurfaceQuerySchema.safeParse({ type: 'list-sessions' }).success).toBe(false);
  });

  test('rejects a get-session-info missing its sdkSessionId', () => {
    expect(
      SurfaceQuerySchema.safeParse({ type: 'get-session-info', requestId: 'x' }).success,
    ).toBe(false);
  });

  test('rejects a rename-session missing its title', () => {
    expect(
      SurfaceQuerySchema.safeParse({
        type: 'rename-session',
        requestId: 'x',
        sdkSessionId: 'u',
      }).success,
    ).toBe(false);
  });
});
