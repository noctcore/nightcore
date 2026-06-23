/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';
import type {
  NightcoreEvent,
  PermissionPolicy,
  SettingSource,
} from '@nightcore/contracts';

/**
 * The Claude CLI is a REQUIRED, user-installed prerequisite — Nightcore does not
 * bundle it. `resolveClaudeBinary()` returns the on-disk path or `undefined` when
 * nothing resolves. We stub it here so a test can force the empty-resolution case
 * (no `claude` installed) without touching the real filesystem, and the resolved
 * case without depending on a `claude` being present on the test machine.
 */
let resolvedClaudePath: string | undefined;
mock.module('./resolve-claude-binary.js', () => ({
  resolveClaudeBinary: () => resolvedClaudePath,
}));

/**
 * Stub the SDK boundary so the resolved-path (happy) case never spawns a live
 * model: a `query()` that yields no messages and completes immediately. The
 * preflight runs BEFORE `query()` is ever called, so the empty-resolution case
 * never reaches this stub at all.
 */
const realSdk = await import('@anthropic-ai/claude-agent-sdk');
let queryCalls = 0;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: () => {
    queryCalls += 1;
    const iterator: AsyncGenerator<unknown> = {
      async next() {
        return { value: undefined, done: true };
      },
      async return() {
        return { value: undefined, done: true };
      },
      async throw(e) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return Object.assign(iterator, {
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
    });
  },
}));

// Imported AFTER the mocks are registered so the runner picks up the stubs.
const { SessionRunner } = await import('./session-runner.js');

const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };
const settingSources: SettingSource[] = [];

function makeRunner(emit: (event: NightcoreEvent) => void) {
  return new SessionRunner(
    {
      sessionId: 1,
      prompt: 'hi',
      model: 'claude-opus-4-8',
      permissionMode: 'default',
      permissionPolicy: policy,
      cwd: process.cwd(),
      apiKeyFallback: false,
      settingSources,
      todoFeatureEnabled: false,
    },
    emit,
  );
}

describe('SessionRunner — Claude CLI preflight', () => {
  test('empty resolution surfaces an actionable runner-crash session-failed', async () => {
    resolvedClaudePath = undefined;
    queryCalls = 0;
    const events: NightcoreEvent[] = [];

    // run() must resolve (degrade-not-throw), not reject, when no CLI resolves.
    await expect(makeRunner((e) => events.push(e)).run()).resolves.toBeUndefined();

    const failed = events.find((e) => e.type === 'session-failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'session-failed') {
      // Reuses an existing reason — no new contract enum value was added.
      expect(failed.reason).toBe('runner-crash');
      expect(failed.message).toContain('Claude CLI not found');
      expect(failed.message).toContain('curl -fsSL https://claude.ai/install.sh | bash');
      expect(failed.message).toContain('https://code.claude.com/docs/en/setup');
    }
    // Fail FAST: the SDK is never invoked when the CLI is missing.
    expect(queryCalls).toBe(0);
  });

  test('a resolved CLI path runs normally — no preflight failure', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    const events: NightcoreEvent[] = [];

    await makeRunner((e) => events.push(e)).run();

    // Happy path is unchanged: the SDK is invoked and no CLI-missing failure fires.
    expect(queryCalls).toBe(1);
    const cliMissing = events.find(
      (e) => e.type === 'session-failed' && e.message.includes('Claude CLI not found'),
    );
    expect(cliMissing).toBeUndefined();
  });
});
