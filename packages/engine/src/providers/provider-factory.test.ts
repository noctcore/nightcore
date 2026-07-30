/// <reference types="bun" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { type Config, ConfigSchema } from '@nightcore/contracts';

import {
  buildProvider,
  buildProviderRegistry,
  REPLAY_TRANSCRIPT_DIR_ENV,
} from './provider-factory.js';

/** A resolved config with a chosen provider (everything else defaulted). */
function configFor(provider: string): Config {
  return ConfigSchema.parse({
    provider,
    paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
  });
}

const OPTS = { apiKeyFallback: false } as const;

describe('buildProvider (the single engine-side selection point)', () => {
  test('config.provider = codex → the Codex provider', () => {
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

describe('buildProviderRegistry', () => {
  test('registers both shipped providers for per-session selection', () => {
    const registry = buildProviderRegistry(configFor('claude'), OPTS);
    expect(registry.all().map((provider) => provider.capabilities().id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(registry.forSession('codex').capabilities().id).toBe('codex');
    expect(registry.forSession('claude').capabilities().id).toBe('claude');
  });

  test('unknown per-session provider falls back to the configured default', () => {
    const registry = buildProviderRegistry(configFor('codex'), OPTS);
    expect(registry.forSession('gemini').capabilities().id).toBe('codex');
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

/**
 * The E2E ladder's replay switch (issue #406). These tests are the gate that keeps a
 * test-only provider from ever becoming reachable in a shipped build: the variable
 * must be BOTH set AND point at a usable directory, and when it is not set nothing
 * about provider selection may change.
 */
describe(`${REPLAY_TRANSCRIPT_DIR_ENV} (E2E ladder replay mode)`, () => {
  const FIXTURES = join(
    import.meta.dir,
    '../../../../apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
  );

  /** Run `fn` with the env var set to `value` (absent when undefined), always
   *  restoring the prior value — a leaked var would silently fake every later test. */
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[REPLAY_TRANSCRIPT_DIR_ENV];
    if (value === undefined) delete process.env[REPLAY_TRANSCRIPT_DIR_ENV];
    else process.env[REPLAY_TRANSCRIPT_DIR_ENV] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[REPLAY_TRANSCRIPT_DIR_ENV];
      else process.env[REPLAY_TRANSCRIPT_DIR_ENV] = prior;
    }
  }

  test('unset ⇒ selection is untouched (the production path)', () => {
    withEnv(undefined, () => {
      expect(buildProvider(configFor('claude'), OPTS).capabilities().id).toBe('claude');
      expect(
        buildProviderRegistry(configFor('claude'), OPTS)
          .all()
          .map((p) => p.capabilities().id)
          .sort(),
      ).toEqual(['claude', 'codex']);
    });
  });

  test('empty/whitespace ⇒ also the production path (never a half-armed switch)', () => {
    withEnv('   ', () => {
      expect(buildProvider(configFor('claude'), OPTS).capabilities().id).toBe('claude');
    });
  });

  test('set to a real transcript dir ⇒ buildProvider returns the replay provider', () => {
    withEnv(FIXTURES, () => {
      expect(buildProvider(configFor('claude'), OPTS).capabilities().id).toBe('replay');
      expect(buildProvider(configFor('codex'), OPTS).capabilities().id).toBe('replay');
    });
  });

  test('set ⇒ the registry serves replay for EVERY provider id, including a named one', () => {
    // The Rust core threads the user's configured id down on every spawn. If a named
    // `providerId` could still reach Claude, a CI ring that believes it is offline
    // would quietly hit a live account.
    withEnv(FIXTURES, () => {
      const registry = buildProviderRegistry(configFor('claude'), OPTS);
      for (const id of [undefined, 'claude', 'codex', 'gemini']) {
        expect(registry.forSession(id).capabilities().id).toBe('replay');
      }
      expect(registry.all().map((p) => p.capabilities().id)).toEqual(['replay']);
    });
  });

  test('set to a non-directory ⇒ THROWS rather than degrading to a real provider', () => {
    // Fail-loud is the whole point: degrading here would turn "my ring replayed a
    // fixture" into "my ring called a live model" without a word in the log.
    withEnv('/nonexistent/nightcore-replay-fixtures', () => {
      expect(() => buildProvider(configFor('claude'), OPTS)).toThrow(
        /not a readable directory/,
      );
      expect(() => buildProviderRegistry(configFor('claude'), OPTS)).toThrow(
        /not a readable directory/,
      );
    });
  });
});
