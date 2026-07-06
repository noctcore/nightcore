/// <reference types="bun" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { type Config, ConfigSchema } from '@nightcore/contracts';

import { buildProvider } from './provider-factory.js';

/** A resolved config with a chosen provider (everything else defaulted). */
function configFor(provider: string): Config {
  return ConfigSchema.parse({
    provider,
    paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
  });
}

const OPTS = { apiKeyFallback: false } as const;

describe('buildProvider (the single engine-side selection point)', () => {
  test('config.provider = codex → the degraded Codex provider', () => {
    const provider = buildProvider(configFor('codex'), OPTS);
    expect(provider.capabilities().id).toBe('codex');
    expect(provider.capabilities().supportsHooks).toBe(false);
  });

  test('config.provider = claude → the Claude provider', () => {
    const provider = buildProvider(configFor('claude'), OPTS);
    expect(provider.capabilities().id).toBe('claude');
    expect(provider.capabilities().supportsHooks).toBe(true);
  });

  test('the default config (no file override) selects Claude', () => {
    const config = ConfigSchema.parse({
      paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
    });
    expect(config.provider).toBe('claude');
    expect(buildProvider(config, OPTS).capabilities().id).toBe('claude');
  });

  test('an unknown provider id falls back to Claude (fail-safe, never a wrong backend)', () => {
    const provider = buildProvider(configFor('gemini'), OPTS);
    expect(provider.capabilities().id).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Acceptance codified: NO `match provider` in the supervisor (issue #18 Phase 4)
// ---------------------------------------------------------------------------

describe('orchestration never branches on the provider id', () => {
  // Scan the supervisor's CODE only — comment lines name paths/ids as prose, not
  // branches (mirrors the Rust `arch_guards` comment-tolerant source scan). A match
  // in code is a `match provider` leak the factory exists to prevent.
  const codeLines = readFileSync(
    join(import.meta.dir, '../session/session-manager.ts'),
    'utf8',
  )
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(
        t.startsWith('//') ||
        t.startsWith('/*') ||
        t.startsWith('*')
      );
    })
    .join('\n')
    .toLowerCase();

  test('the supervisor code never names a specific provider id', () => {
    // Selection lives entirely in buildProvider; a `codex`/`gemini` literal in the
    // supervisor would be exactly the branch the seam removes.
    expect(codeLines).not.toContain('codex');
    expect(codeLines).not.toContain('gemini');
  });

  test('the supervisor code never reads the provider id (it delegates to the factory)', () => {
    // It hands the whole `config` to buildProvider and drives the returned
    // AgentProvider; reading `config.provider` itself would reopen a branch point.
    expect(codeLines).not.toContain('config.provider');
    expect(codeLines).not.toContain('.provider ===');
  });
});
