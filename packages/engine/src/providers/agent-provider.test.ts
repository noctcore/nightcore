/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type AutonomyLevel,
  type Config,
  ConfigSchema,
  type PermissionMode,
  type ProviderCapabilities,
} from '@nightcore/contracts';

import {
  assertHooksInvariant,
  AutonomyNotPermittedError,
} from './agent-provider.js';
import {
  CLAUDE_CAPABILITIES,
  permissionModeToAutonomy,
} from './claude/capabilities.js';
import { ClaudeAgentProvider } from './claude/claude-agent-provider.js';

/** A fake provider descriptor with the ONLY difference that matters to the gate:
 *  it cannot enforce PreToolUse hooks (no workspace confinement / deny-ask tiers). */
const DEGRADED: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'fake',
  label: 'Fake',
  supportsHooks: false,
};

// ---------------------------------------------------------------------------
// The fail-closed hooks invariant (the security crux, issue #18)
// ---------------------------------------------------------------------------

describe('assertHooksInvariant', () => {
  test('REFUSES elevated autonomy when hooks are unsupported and unsandboxed', () => {
    for (const autonomy of ['bypass', 'auto-accept'] as const) {
      expect(() =>
        assertHooksInvariant(DEGRADED, autonomy, { osSandboxed: false }),
      ).toThrow(AutonomyNotPermittedError);
    }
  });

  test('permits elevated autonomy when the OS sandbox compensates', () => {
    for (const autonomy of ['bypass', 'auto-accept'] as const) {
      expect(() =>
        assertHooksInvariant(DEGRADED, autonomy, { osSandboxed: true }),
      ).not.toThrow();
    }
  });

  test('never refuses non-elevated autonomy, even without hooks or a sandbox', () => {
    for (const autonomy of ['ask', 'plan'] as const) {
      expect(() =>
        assertHooksInvariant(DEGRADED, autonomy, { osSandboxed: false }),
      ).not.toThrow();
    }
  });

  test('a hooks-capable provider is never refused, at any autonomy', () => {
    const levels: AutonomyLevel[] = ['bypass', 'auto-accept', 'ask', 'plan'];
    for (const autonomy of levels) {
      expect(() =>
        assertHooksInvariant(CLAUDE_CAPABILITIES, autonomy, {
          osSandboxed: false,
        }),
      ).not.toThrow();
    }
  });

  test('the refusal names the offending provider and autonomy', () => {
    let caught: unknown;
    try {
      assertHooksInvariant(DEGRADED, 'bypass', { osSandboxed: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AutonomyNotPermittedError);
    const err = caught as AutonomyNotPermittedError;
    expect(err.providerId).toBe('fake');
    expect(err.autonomy).toBe('bypass');
    expect(err.message).toContain('hooks');
  });
});

// ---------------------------------------------------------------------------
// The Claude-internal PermissionMode → AutonomyLevel bridge
// ---------------------------------------------------------------------------

describe('permissionModeToAutonomy', () => {
  const cases: ReadonlyArray<readonly [PermissionMode, AutonomyLevel]> = [
    ['bypassPermissions', 'bypass'],
    ['acceptEdits', 'auto-accept'],
    ['dontAsk', 'auto-accept'],
    ['auto', 'auto-accept'],
    ['plan', 'plan'],
    ['default', 'ask'],
  ];
  test.each(cases)('maps %s → %s', (mode, autonomy) => {
    expect(permissionModeToAutonomy(mode)).toBe(autonomy);
  });

  test('the never-prompt modes land in the elevated set the gate guards', () => {
    // dontAsk/auto act without a per-tool prompt, so a no-hooks provider running
    // them unsandboxed must be refused (fail-closed).
    for (const mode of ['dontAsk', 'auto'] as const) {
      expect(() =>
        assertHooksInvariant(DEGRADED, permissionModeToAutonomy(mode), {
          osSandboxed: false,
        }),
      ).toThrow(AutonomyNotPermittedError);
    }
  });
});

// ---------------------------------------------------------------------------
// ClaudeAgentProvider (the one implementation behind the seam)
// ---------------------------------------------------------------------------

const CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

describe('ClaudeAgentProvider', () => {
  const provider = new ClaudeAgentProvider(CONFIG, { apiKeyFallback: false });

  test('advertises the truthful Claude capability matrix', () => {
    const caps = provider.capabilities();
    expect(caps.id).toBe('claude');
    expect(caps.supportsHooks).toBe(true);
    expect(caps.supportsMcp).toBe(true);
    expect(caps.supportsPlanMode).toBe(true);
    expect(caps.supportsStructuredOutput).toBe(true);
    expect(caps.supportsSessionResume).toBe(true);
    expect(caps.supportsFileCheckpointing).toBe(true);
    expect(caps.supportsAskUserQuestion).toBe(true);
    expect(caps.supportsSettingSources).toBe(true);
    expect(caps.supportsSessionStore).toBe(true);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.costTelemetry).toBe('full');
    expect(caps.autonomyLevels).toEqual([
      'bypass',
      'auto-accept',
      'ask',
      'plan',
    ]);
  });

  test('preflight NEVER refuses Claude — bypass without a sandbox is fine', () => {
    expect(() =>
      provider.preflight({
        autonomy: 'bypass',
        osSandboxed: false,
      }),
    ).not.toThrow();
  });

  test('startSession resolves the autonomy precedence: override wins', () => {
    const session = provider.startSession(
      {
        sessionId: 1,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        cwd: '/tmp',
        autonomyOverride: 'plan',
      },
      () => {},
    );
    expect(session.permissionMode).toBe('plan');
  });

  test('startSession falls back to the configured default permission mode', () => {
    const session = provider.startSession(
      { sessionId: 2, prompt: 'hi', model: 'claude-opus-4-8', cwd: '/tmp' },
      () => {},
    );
    expect(session.permissionMode).toBe(CONFIG.permissions.mode);
  });

  test('startSession applies the kind preset default when no override is given', () => {
    // `verify` (review reviewer) defaults to `dontAsk`; no command override here.
    const session = provider.startSession(
      {
        sessionId: 3,
        prompt: 'review',
        model: 'claude-opus-4-8',
        cwd: '/tmp',
        kind: 'review',
      },
      () => {},
    );
    expect(session.permissionMode).toBe('dontAsk');
  });

  test('createProbeSession yields a driveable session handle', () => {
    const probe = provider.createProbeSession();
    expect(typeof probe.listModels).toBe('function');
    expect(typeof probe.probeConfig).toBe('function');
  });
});
