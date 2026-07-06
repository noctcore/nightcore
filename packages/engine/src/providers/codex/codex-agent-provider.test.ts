/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent } from '@nightcore/contracts';

import { AutonomyNotPermittedError } from '../agent-provider.js';
import { CODEX_CAPABILITIES } from './capabilities.js';
import { CodexAgentProvider } from './codex-agent-provider.js';

/** Collect every event a session emits, so the tests can assert the honest
 *  provider-unavailable failure (and nothing pretending to run). */
function collector(): {
  emit: (event: NightcoreEvent) => void;
  events: NightcoreEvent[];
} {
  const events: NightcoreEvent[] = [];
  return { emit: (event) => events.push(event), events };
}

const provider = new CodexAgentProvider();

// ---------------------------------------------------------------------------
// The degraded descriptor — exercises every degradation rule
// ---------------------------------------------------------------------------

describe('CODEX_CAPABILITIES', () => {
  test('advertises a truthful DEGRADED matrix', () => {
    expect(CODEX_CAPABILITIES.id).toBe('codex');
    expect(CODEX_CAPABILITIES.label).toBe('Codex');
    // The crux + the rest of the missing SDK control surface.
    expect(CODEX_CAPABILITIES.supportsHooks).toBe(false);
    expect(CODEX_CAPABILITIES.supportsMcp).toBe(false);
    expect(CODEX_CAPABILITIES.supportsStructuredOutput).toBe(false);
    expect(CODEX_CAPABILITIES.supportsSessionResume).toBe(false);
    expect(CODEX_CAPABILITIES.supportsFileCheckpointing).toBe(false);
    expect(CODEX_CAPABILITIES.supportsAskUserQuestion).toBe(false);
    expect(CODEX_CAPABILITIES.supportsSettingSources).toBe(false);
    expect(CODEX_CAPABILITIES.supportsSessionStore).toBe(false);
    expect(CODEX_CAPABILITIES.supportsEffort).toBe(false);
    expect(CODEX_CAPABILITIES.costTelemetry).toBe('none');
  });

  test('offers only the reduced (safe) autonomy set — no elevated ceilings', () => {
    expect(CODEX_CAPABILITIES.autonomyLevels).toEqual(['ask', 'plan']);
    expect(CODEX_CAPABILITIES.autonomyLevels).not.toContain('bypass');
    expect(CODEX_CAPABILITIES.autonomyLevels).not.toContain('auto-accept');
  });

  test('the provider advertises exactly that descriptor', () => {
    expect(provider.capabilities()).toBe(CODEX_CAPABILITIES);
  });
});

// ---------------------------------------------------------------------------
// (a) The fail-closed hooks invariant fires for a REAL second provider
// ---------------------------------------------------------------------------

describe('CodexAgentProvider.preflight (the security crux)', () => {
  test('REFUSES elevated autonomy — bypass/auto-accept, unsandboxed', () => {
    for (const autonomy of ['bypass', 'auto-accept'] as const) {
      expect(() =>
        provider.preflight({ autonomy, osSandboxed: false }),
      ).toThrow(AutonomyNotPermittedError);
    }
  });

  test('the refusal names the codex provider and the offending autonomy', () => {
    let caught: unknown;
    try {
      provider.preflight({ autonomy: 'bypass', osSandboxed: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutonomyNotPermittedError);
    const err = caught as AutonomyNotPermittedError;
    expect(err.providerId).toBe('codex');
    expect(err.autonomy).toBe('bypass');
  });

  test('permits elevated autonomy when the OS sandbox compensates', () => {
    for (const autonomy of ['bypass', 'auto-accept'] as const) {
      expect(() =>
        provider.preflight({ autonomy, osSandboxed: true }),
      ).not.toThrow();
    }
  });

  test('never refuses the safe ceilings (ask/plan)', () => {
    for (const autonomy of ['ask', 'plan'] as const) {
      expect(() =>
        provider.preflight({ autonomy, osSandboxed: false }),
      ).not.toThrow();
    }
  });

  test('startSession refuses an elevated autonomy override before building a session', () => {
    const { emit, events } = collector();
    expect(() =>
      provider.startSession(
        {
          sessionId: 1,
          prompt: 'go',
          model: 'codex',
          cwd: '/tmp',
          autonomyOverride: 'bypass',
        },
        emit,
      ),
    ).toThrow(AutonomyNotPermittedError);
    // Refused BEFORE any event — confinement is never silently dropped.
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) ask/plan sessions construct and fail with the honest unavailable error
// ---------------------------------------------------------------------------

describe('CodexAgentProvider.startSession (honest stub)', () => {
  test.each(['ask', 'plan'] as const)(
    'a %s session constructs, then run() emits a provider-unavailable failure',
    async (autonomy) => {
      const { emit, events } = collector();
      const session = provider.startSession(
        {
          sessionId: 7,
          prompt: 'go',
          model: 'codex',
          cwd: '/tmp',
          autonomyOverride: autonomy,
        },
        emit,
      );
      // The record mode reflects the resolved autonomy (plan→plan, ask→default).
      expect(session.permissionMode).toBe(autonomy === 'plan' ? 'plan' : 'default');

      await session.run();

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe('session-failed');
      if (event.type === 'session-failed') {
        expect(event.sessionId).toBe(7);
        expect(event.reason).toBe('unknown');
        expect(event.message).toContain('Codex');
      }
    },
  );

  test('defaults to the safe `ask` ceiling when no override is given', () => {
    const { emit } = collector();
    const session = provider.startSession(
      { sessionId: 8, prompt: 'go', model: 'codex', cwd: '/tmp' },
      emit,
    );
    expect(session.permissionMode).toBe('default');
  });

  test('run() never rejects (degrade-not-throw)', async () => {
    const { emit } = collector();
    const session = provider.startSession(
      { sessionId: 9, prompt: 'go', model: 'codex', cwd: '/tmp' },
      emit,
    );
    await expect(session.run()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Degradation visibility: the probe surfaces + inert controls
// ---------------------------------------------------------------------------

describe('CodexAgentProvider probe surface', () => {
  test('probeConfig reports every section unsupported under the codex label', async () => {
    const probe = provider.createProbeSession();
    const snapshot = await probe.probeConfig('/repo');
    expect(snapshot.providerId).toBe('codex');
    expect(snapshot.providerLabel).toBe('Codex');
    expect(snapshot.projectPath).toBe('/repo');
    expect(snapshot.mcp.status).toBe('unsupported');
    expect(snapshot.skills.status).toBe('unsupported');
    expect(snapshot.subagents.status).toBe('unsupported');
    expect(snapshot.extrasStatus).toBe('unsupported');
  });

  test('listModels degrades to an empty list', async () => {
    const probe = provider.createProbeSession();
    await expect(probe.listModels()).resolves.toEqual([]);
  });

  test('the inert controls are safe no-ops', async () => {
    const { emit } = collector();
    const session = provider.startSession(
      { sessionId: 10, prompt: 'go', model: 'codex', cwd: '/tmp' },
      emit,
    );
    expect(
      session.approvePermission('req-1', { behavior: 'deny', message: 'no' }),
    ).toBe(false);
    expect(session.answerQuestion('req-1', { behavior: 'cancel' })).toBe(false);
    session.streamInput('more');
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.setModel('codex')).resolves.toBeUndefined();
    await expect(session.setAutonomy('ask')).resolves.toBeUndefined();
  });
});
