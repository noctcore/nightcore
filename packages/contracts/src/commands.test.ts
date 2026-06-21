/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { SurfaceCommandSchema, type SurfaceCommand } from './commands.js';

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
