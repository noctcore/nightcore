/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent, PermissionPolicy } from '@nightcore/contracts';

import { createSessionGuards } from './session-guards.js';
import type { SessionRunnerConfig } from './session-options.js';

const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };

function makeConfig(
  overrides: Partial<SessionRunnerConfig> = {},
): SessionRunnerConfig {
  return {
    sessionId: 7,
    prompt: 'hi',
    model: 'claude-opus-4-8',
    permissionMode: 'default',
    permissionPolicy: policy,
    cwd: process.cwd(),
    apiKeyFallback: false,
    settingSources: [],
    todoFeatureEnabled: false,
    ...overrides,
  };
}

describe('createSessionGuards', () => {
  test('assembles the hook bus + permission and question layers', () => {
    const guards = createSessionGuards(makeConfig(), () => {}, undefined);
    expect(guards.hooks).toBeDefined();
    expect(guards.permissions).toBeDefined();
    expect(guards.questions).toBeDefined();
    // The HookBus is usable — it produces the SDK hook wiring the runner passes on.
    expect(guards.hooks.hooks()).toBeDefined();
  });

  test('a parked permission maps into a session-scoped permission-required event', () => {
    const events: NightcoreEvent[] = [];
    const guards = createSessionGuards(
      makeConfig({ sessionId: 99 }),
      (event) => events.push(event),
      undefined,
    );

    // An unknown-risk tool that is not allow-listed parks for approval, firing the
    // layer's onPrompt — the callback under test. Fire-and-forget: it never settles.
    void guards.permissions.canUseTool('MysteryTool', { foo: 'bar' }, {
      signal: new AbortController().signal,
    } as Parameters<typeof guards.permissions.canUseTool>[2]);

    const required = events.find((e) => e.type === 'permission-required');
    expect(required).toBeDefined();
    if (required?.type === 'permission-required') {
      expect(required.sessionId).toBe(99);
      expect(required.toolName).toBe('MysteryTool');
      expect(required.input).toEqual({ foo: 'bar' });
      expect(typeof required.requestId).toBe('string');
    }

    // No approval will arrive — release the parked promise so the test exits clean.
    guards.permissions.failAllPending();
  });
});
