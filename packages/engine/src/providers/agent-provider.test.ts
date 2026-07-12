/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type AutonomyLevel,
  type Config,
  ConfigSchema,
  type HarnessPolicy,
  type PermissionMode,
  type ProviderCapabilities,
} from '@nightcore/contracts';

import {
  assertGovernanceInvariant,
  assertHooksInvariant,
  AutonomyNotPermittedError,
  GovernanceNotSupportedError,
} from './agent-provider.js';
import {
  CLAUDE_CAPABILITIES,
  permissionModeToAutonomy,
} from './claude/capabilities.js';
import { ClaudeAgentProvider } from './claude/claude-agent-provider.js';
import { CODEX_CAPABILITIES } from './codex/capabilities.js';

/** A fake provider descriptor with the ONLY difference that matters to the gate:
 *  it cannot enforce PreToolUse hooks (no workspace confinement / deny-ask tiers). */
const DEGRADED: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'fake',
  label: 'Fake',
  supportsHooks: false,
};

/** A fake provider that cannot enforce Harness governance policy or write the
 *  audit ledger — otherwise identical to Claude (mirrors `CODEX_CAPABILITIES`'s
 *  shape without hardcoding the real Codex descriptor into this gate battery). */
const UNGOVERNED: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'fake-ungoverned',
  label: 'FakeUngoverned',
  supportsHarnessPolicy: false,
  supportsLedger: false,
};

/** An armed-but-empty Harness policy — presence alone is what arms the layer
 *  (mirrors the Rust `read_policy` resolver: an armed policy can have empty lists
 *  and still be "on", guarding the manifest itself). */
const ARMED_POLICY: HarnessPolicy = {
  protectedPaths: [],
  denyBashPatterns: [],
  denyReadPaths: [],
  disallowedTools: [],
  allowTools: [],
  askTools: [],
  allowExecSinks: [],
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
    for (const autonomy of ['auto-accept'] as const) {
      expect(() =>
        assertHooksInvariant(DEGRADED, autonomy, { osSandboxed: true }),
      ).not.toThrow();
    }
  });

  test('bypass remains refused without explicit uncontained opt-in', () => {
    expect(() =>
      assertHooksInvariant(DEGRADED, 'bypass', { osSandboxed: false }),
    ).toThrow(AutonomyNotPermittedError);
    expect(() =>
      assertHooksInvariant(DEGRADED, 'bypass', {
        osSandboxed: false,
        uncontainedBypassOptIn: true,
      }),
    ).not.toThrow();
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
// The fail-closed governance invariant (issue #296)
// ---------------------------------------------------------------------------

describe('assertGovernanceInvariant', () => {
  test('REFUSES a run with an armed Harness policy on an ungoverned provider', () => {
    expect(() =>
      assertGovernanceInvariant(UNGOVERNED, { harnessPolicy: ARMED_POLICY }),
    ).toThrow(GovernanceNotSupportedError);
  });

  test('REFUSES a run with a ledger request on a provider that cannot write one', () => {
    expect(() =>
      assertGovernanceInvariant(UNGOVERNED, { ledgerPath: '/tmp/nc-ledger.ndjson' }),
    ).toThrow(GovernanceNotSupportedError);
  });

  test('permits a run with NO active policy or ledger, even on an ungoverned provider', () => {
    expect(() => assertGovernanceInvariant(UNGOVERNED, {})).not.toThrow();
  });

  test('a governance-capable provider is never refused, policy and ledger both requested', () => {
    expect(() =>
      assertGovernanceInvariant(CLAUDE_CAPABILITIES, {
        harnessPolicy: ARMED_POLICY,
        ledgerPath: '/tmp/nc-ledger.ndjson',
      }),
    ).not.toThrow();
  });

  test('is driven by the capability descriptor, not the provider id', () => {
    // A provider named "codex" that DID advertise support is never refused; a
    // provider named anything else that does NOT advertise support IS refused —
    // proving the gate reads `capabilities.supportsHarnessPolicy`, never `id`.
    const governedCodex: ProviderCapabilities = {
      ...UNGOVERNED,
      id: 'codex',
      supportsHarnessPolicy: true,
      supportsLedger: true,
    };
    expect(() =>
      assertGovernanceInvariant(governedCodex, { harnessPolicy: ARMED_POLICY }),
    ).not.toThrow();

    const ungovernedOther: ProviderCapabilities = { ...UNGOVERNED, id: 'some-future-provider' };
    expect(() =>
      assertGovernanceInvariant(ungovernedOther, { harnessPolicy: ARMED_POLICY }),
    ).toThrow(GovernanceNotSupportedError);
  });

  test('the refusal names the offending provider and both gaps in the message', () => {
    let caught: unknown;
    try {
      assertGovernanceInvariant(UNGOVERNED, {
        harnessPolicy: ARMED_POLICY,
        ledgerPath: '/tmp/nc-ledger.ndjson',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GovernanceNotSupportedError);
    const err = caught as GovernanceNotSupportedError;
    expect(err.providerId).toBe('fake-ungoverned');
    expect(err.missingHarnessPolicy).toBe(true);
    expect(err.missingLedger).toBe(true);
    expect(err.message).toContain("fake-ungoverned");
    expect(err.message).toContain('Harness governance policy');
    expect(err.message).toContain('audit ledger');
  });

  test('CODEX_CAPABILITIES honestly declares no governance support', () => {
    expect(CODEX_CAPABILITIES.supportsHarnessPolicy).toBe(false);
    expect(CODEX_CAPABILITIES.supportsLedger).toBe(false);
  });

  test('CLAUDE_CAPABILITIES declares full governance support', () => {
    expect(CLAUDE_CAPABILITIES.supportsHarnessPolicy).toBe(true);
    expect(CLAUDE_CAPABILITIES.supportsLedger).toBe(true);
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
    expect(caps.providesOwnWriteContainment).toBe(false);
    expect(caps.supportsMcp).toBe(true);
    expect(caps.supportsPlanMode).toBe(true);
    expect(caps.supportsStructuredOutput).toBe(true);
    expect(caps.supportsSessionResume).toBe(true);
    expect(caps.supportsFileCheckpointing).toBe(true);
    expect(caps.supportsAskUserQuestion).toBe(true);
    expect(caps.supportsSettingSources).toBe(true);
    expect(caps.supportsSessionStore).toBe(true);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.supportsHarnessPolicy).toBe(true);
    expect(caps.supportsLedger).toBe(true);
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

  test('startSession proceeds with an armed Harness policy and a ledger path (#296)', () => {
    const session = provider.startSession(
      {
        sessionId: 100,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        cwd: '/tmp',
        harnessPolicy: ARMED_POLICY,
        ledgerPath: '/tmp/nc-ledger.ndjson',
      },
      () => {},
    );
    expect(session).toBeDefined();
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
