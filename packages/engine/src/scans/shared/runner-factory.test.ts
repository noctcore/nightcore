/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type {
  PermissionMode,
  PermissionPolicy,
} from '@nightcore/contracts';

import type { SessionRunnerConfig } from '../../providers/claude/session-runner.js';
import { SessionRunner } from '../../providers/claude/session-runner.js';
import { defaultRunnerFactory } from './runner-factory.js';

const POLICY: PermissionPolicy = { allow: [], deny: [], mode: 'default' };

/** A minimal valid `SessionRunnerConfig` — enough to CONSTRUCT a `SessionRunner`
 *  (which only wires its layers; `query()` fires later in `run()`), so the factory
 *  can be exercised without spawning a real provider subprocess. */
function minimalConfig(): SessionRunnerConfig {
  return {
    sessionId: 1,
    prompt: 'read-only scan pass',
    model: 'claude-opus-4-8',
    permissionMode: 'default' as PermissionMode,
    permissionPolicy: POLICY,
    cwd: '/tmp/scan-runner-factory-test',
    apiKeyFallback: false,
    settingSources: [],
    todoFeatureEnabled: false,
  };
}

describe('defaultRunnerFactory', () => {
  test('wires the production Claude runner satisfying the ScanSessionRunner seam', () => {
    // The factory is the default the orchestrator falls back to when no test fake is
    // injected; it must build the real Claude `SessionRunner` and expose the minimal
    // run()/interrupt() slice the pool drives + cancel interrupts through. Merely
    // constructing it must not spawn a subprocess (query() only fires in run()).
    const runner = defaultRunnerFactory(minimalConfig(), () => {});

    expect(runner).toBeInstanceOf(SessionRunner);
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.interrupt).toBe('function');
  });

  test('returns a fresh runner per call — each concurrent pass owns its own', () => {
    // The pool tracks every live runner in the run's `Set` so cancel can interrupt
    // each independently; two passes must never share one runner instance.
    const first = defaultRunnerFactory(minimalConfig(), () => {});
    const second = defaultRunnerFactory(minimalConfig(), () => {});

    expect(first).not.toBe(second);
  });
});
