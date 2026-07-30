import path from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';

import type { NightcoreEvent } from '@nightcore/contracts';

import type { StartSessionParams } from '../agent-provider.js';
import { REPLAY_CAPABILITIES, REPLAY_PROVIDER_ID } from './capabilities.js';
import { ReplayAgentProvider } from './replay-agent-provider.js';

/** The canonical fixtures, shared with ring 1(c)'s Rust drivers. Everything below
 *  replays the REAL checked-in transcripts — a provider test against invented events
 *  would pass while the ladder's actual input was broken. */
const FIXTURES = path.resolve(
  import.meta.dir,
  '../../../../../apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
);

function params(over: Partial<StartSessionParams> = {}): StartSessionParams {
  return {
    sessionId: 42,
    prompt: 'fix the bug',
    model: 'replay-fixture',
    cwd: '/tmp',
    kind: 'build',
    ...over,
  };
}

async function replay(over: Partial<StartSessionParams> = {}) {
  const events: NightcoreEvent[] = [];
  const provider = new ReplayAgentProvider(FIXTURES);
  await provider.startSession(params(over), (event) => events.push(event)).run();
  return events;
}

beforeEach(() => {
  delete process.env.NIGHTCORE_E2E_REPLAY_PACE_MS;
});

describe('ReplayAgentProvider', () => {
  test('advertises the replay capability descriptor', () => {
    expect(new ReplayAgentProvider(FIXTURES).capabilities()).toBe(REPLAY_CAPABILITIES);
    expect(REPLAY_CAPABILITIES.id).toBe(REPLAY_PROVIDER_ID);
  });

  test('replays the build transcript in wire order, ending on the terminal', async () => {
    const events = await replay();
    expect(events.map((e) => e.type)).toEqual([
      'session-ready',
      'assistant-delta',
      'tool-use-requested',
      'tool-result',
      'tool-use-requested',
      'tool-result',
      'assistant-delta',
      'session-completed',
    ]);
  });

  test('re-stamps every event onto the LIVE session id', async () => {
    // The fixture records sessionId 7; replaying that verbatim would bind the run to a
    // session the supervisor never opened, and the Rust reader's FIFO correlation
    // would never match it.
    const events = await replay({ sessionId: 99 });
    expect(events.every((e) => 'sessionId' in e && e.sessionId === 99)).toBe(true);
  });

  test('carries the recorded payload through untouched', async () => {
    const events = await replay();
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'session-completed',
      result:
        'Awaited the save() call in src/handler.ts and confirmed the test suite passes.',
      numTurns: 7,
    });
  });

  test('a `#replay` directive selects the failure transcript', async () => {
    const events = await replay({ prompt: '#replay build-failed' });
    expect(events.at(-1)).toMatchObject({
      type: 'session-failed',
      reason: 'max-turns',
      sessionId: 42,
    });
  });

  test('a missing transcript degrades to a terminal session-failed, not a throw', async () => {
    // Degrade-not-throw is the seam's contract; the message still names the file so a
    // ring fails with a diagnosis rather than a hang.
    const events = await replay({ prompt: '#replay does-not-exist' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'session-failed', reason: 'runner-crash' });
    expect((events[0] as { message: string }).message).toMatch(/does-not-exist\.jsonl/);
  });

  test('an interrupt cuts the stream and settles exactly one terminal', async () => {
    process.env.NIGHTCORE_E2E_REPLAY_PACE_MS = '5';
    const events: NightcoreEvent[] = [];
    const session = new ReplayAgentProvider(FIXTURES).startSession(params(), (e) =>
      events.push(e),
    );
    const running = session.run();
    await session.interrupt();
    await running;
    const terminals = events.filter(
      (e) => e.type === 'session-completed' || e.type === 'session-failed',
    );
    // Exactly one terminal: two would double-release the Rust slot — the very class
    // `e2e::slot_leak` guards.
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'session-failed', reason: 'aborted' });
  });

  test('reflects the requested autonomy as the session permission mode', () => {
    const provider = new ReplayAgentProvider(FIXTURES);
    expect(
      provider.startSession(params({ autonomyOverride: 'plan' }), () => {}).permissionMode,
    ).toBe('plan');
    expect(provider.startSession(params(), () => {}).permissionMode).toBe(
      'bypassPermissions',
    );
  });

  test('preflight never refuses — the provider executes nothing to confine', () => {
    // Documented, argued exception (see the method docblock): the elevated-autonomy
    // invariant guards tool execution, and this provider has none. Pinned as a test so
    // a future edit that "restores" the invariant here has to confront the reasoning.
    expect(() =>
      new ReplayAgentProvider(FIXTURES).preflight({
        autonomy: 'bypass',
        osSandboxed: false,
      }),
    ).not.toThrow();
  });

  test('probe sessions answer models + provider config deterministically', async () => {
    const probe = new ReplayAgentProvider(FIXTURES).createProbeSession();
    const models = await probe.listModels();
    expect(models.map((m) => m.value)).toEqual(['replay-fixture']);
    const snapshot = await probe.probeConfig('/repo');
    expect(snapshot).toMatchObject({
      providerId: REPLAY_PROVIDER_ID,
      projectPath: '/repo',
      extrasStatus: 'unsupported',
    });
  });

  test('parks nothing, so permission/question decisions are answered false', () => {
    const session = new ReplayAgentProvider(FIXTURES).startSession(params(), () => {});
    expect(session.approvePermission('r1', 'allow')).toBe(false);
    expect(session.answerQuestion('r1', { header: 'h', label: 'l' })).toBe(false);
  });

  test('live controls are inert no-ops rather than throws', async () => {
    const session = new ReplayAgentProvider(FIXTURES).startSession(params(), () => {});
    session.streamInput('more context');
    await expect(session.setModel('other')).resolves.toBeUndefined();
    await expect(session.setAutonomy('ask')).resolves.toBeUndefined();
  });
});
