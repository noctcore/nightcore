/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type {
  McpServerEntry,
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
/** The SDK `Options` object from the most recent `query()` call, for assertions. */
let lastQueryOptions: Record<string, unknown> | undefined;
/** Messages the stubbed `query()` should yield before completing. Default `[]`
 *  reproduces the yields-nothing case; a test can queue a scripted stream. */
let queuedMessages: unknown[] = [];
/** When true, the stubbed `query()` yields its queued messages (if any) and then
 *  WEDGES — `next()` returns a promise that never resolves — reproducing a
 *  subprocess that stopped yielding without a terminal `result`. The idle
 *  watchdog must trip and fail the session so the slot is freed. */
let stallStream = false;
/** Counts `interrupt()` calls on the stubbed query, so a test can assert the
 *  stall path tears the subprocess down. */
let interruptCalls = 0;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: { options?: Record<string, unknown> }) => {
    queryCalls += 1;
    lastQueryOptions = args?.options;
    const pending = [...queuedMessages];
    const iterator: AsyncGenerator<unknown> = {
      async next() {
        const value = pending.shift();
        if (value === undefined && stallStream) {
          // Wedge: never resolve, never reject — the watchdog is the only exit.
          return new Promise<IteratorResult<unknown>>(() => {});
        }
        return value === undefined
          ? { value: undefined, done: true }
          : { value, done: false };
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
      async interrupt() {
        interruptCalls += 1;
      },
      async setModel() {},
      async setPermissionMode() {},
    });
  },
}));

// Imported AFTER the mocks are registered so the runner picks up the stubs.
const { SessionRunner } = await import('./session-runner.js');
// The pure option-composition helpers now live in `session-options.ts` (extracted
// from the runner so they are testable without spinning a query).
const { toSdkMcpServers, composeAppendSystemPrompt, CONTEXT_PACK_MAX_CHARS } =
  await import('./session-options.js');

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

  test('does NOT register built-in subagent presets on the main session', async () => {
    // Regression: registering `Options.agents` exposes the SDK `Agent` (Task)
    // tool to the main model, which then delegates shell work (e.g.
    // `bun run … build`/test) to a subagent instead of calling `Bash` directly —
    // surfacing as confusing `Agent`/`subagent_type` log entries. The main
    // session must run with native tools only, so `agents` must be absent.
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;

    await makeRunner(() => {}).run();

    expect(queryCalls).toBe(1);
    expect(lastQueryOptions).toBeDefined();
    expect(lastQueryOptions).not.toHaveProperty('agents');
  });
});

describe('SessionRunner — assistant-error → failure reason threading', () => {
  test('an assistant-level error refines the terminal failure reason', async () => {
    // The SDK signals a throttle/auth stall via the assistant frame's `error`
    // field; the terminal `result` message carries no reason. The runner must
    // thread the last assistant error into the translation so a rate-limit stall
    // surfaces as a distinct reason instead of collapsing to `unknown`.
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    queuedMessages = [
      {
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [] },
        session_id: 's',
        uuid: 'u1',
      },
      { type: 'result', subtype: 'error_during_execution', errors: [], session_id: 's', uuid: 'u2' },
    ];
    const events: NightcoreEvent[] = [];

    await makeRunner((e) => events.push(e)).run();

    queuedMessages = [];
    const failed = events.find((e) => e.type === 'session-failed');
    expect(failed?.type).toBe('session-failed');
    if (failed?.type === 'session-failed') {
      expect(failed.reason).toBe('rate-limit');
    }
  });
});

describe('SessionRunner — idle watchdog frees a wedged subprocess', () => {
  test('a stalled stream fails the session (runner-crash) instead of hanging forever', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    stallStream = true;
    queuedMessages = [];
    const events: NightcoreEvent[] = [];

    // A tiny idle deadline so the watchdog trips fast; the real default is
    // 30 minutes. run() MUST resolve (degrade-not-throw), not hang, when the
    // subprocess wedges mid-turn without a terminal `result`.
    const runner = new SessionRunner(
      {
        sessionId: 42,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        permissionPolicy: policy,
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        idleTimeoutMs: 20,
      },
      (e) => events.push(e),
    );

    await expect(runner.run()).resolves.toBeUndefined();
    stallStream = false;

    const failed = events.find((e) => e.type === 'session-failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'session-failed') {
      expect(failed.reason).toBe('runner-crash');
      expect(failed.message).toContain('stalled');
    }
    // The wedged subprocess is torn down (abort + interrupt), not leaked.
    expect(interruptCalls).toBeGreaterThanOrEqual(1);
  });

  test('a stream that yields then wedges still trips the watchdog', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    stallStream = true;
    // One non-terminal assistant frame, then the stream wedges (no `result`).
    queuedMessages = [
      { type: 'assistant', message: { content: [] }, session_id: 's', uuid: 'u1' },
    ];
    const events: NightcoreEvent[] = [];

    const runner = new SessionRunner(
      {
        sessionId: 43,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        permissionPolicy: policy,
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        idleTimeoutMs: 20,
      },
      (e) => events.push(e),
    );

    await expect(runner.run()).resolves.toBeUndefined();
    stallStream = false;
    queuedMessages = [];

    const failed = events.find((e) => e.type === 'session-failed');
    expect(failed?.type).toBe('session-failed');
    if (failed?.type === 'session-failed') {
      expect(failed.reason).toBe('runner-crash');
    }
  });
});

describe('toSdkMcpServers — contract → SDK Options.mcpServers', () => {
  const stdio = (
    id: string,
    name: string,
    enabled: boolean,
    extra: Partial<{ args: string[]; env: Record<string, string> }> = {},
  ): McpServerEntry => ({
    id,
    name,
    enabled,
    config: {
      transport: 'stdio',
      command: 'npx',
      args: extra.args ?? [],
      env: extra.env ?? {},
    },
  });

  test('an absent or empty list yields undefined (the key is omitted)', () => {
    // Byte-identical to the pre-feature options: no `mcpServers` key at all.
    expect(toSdkMcpServers(undefined)).toBeUndefined();
    expect(toSdkMcpServers([])).toBeUndefined();
  });

  test('a list of only-disabled entries yields undefined', () => {
    expect(toSdkMcpServers([stdio('a', 'alpha', false)])).toBeUndefined();
  });

  test('disabled entries are dropped; the name becomes the record key', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'alpha', true, { args: ['-y', 'pkg'], env: { ROOT: '/x' } }),
      stdio('b', 'bravo', false),
      stdio('c', 'charlie', true),
    ]);
    expect(servers).toBeDefined();
    expect(Object.keys(servers ?? {}).sort()).toEqual(['alpha', 'charlie']);
  });

  test('stdio OMITS `type` and only sets env when non-empty', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'with-env', true, { args: ['-y', 'pkg'], env: { K: 'v' } }),
      stdio('b', 'no-env', true),
    ]);
    const withEnv = servers?.['with-env'];
    const noEnv = servers?.['no-env'];
    // stdio config has no `type` key (the SDK defaults `type?: 'stdio'`).
    expect(withEnv).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
    expect(withEnv && 'type' in withEnv).toBe(false);
    // An empty env map is omitted entirely.
    expect(noEnv).toEqual({ command: 'npx', args: [] });
    expect(noEnv && 'env' in noEnv).toBe(false);
  });

  test('http SETS type=http and only sets headers when non-empty', () => {
    const servers = toSdkMcpServers([
      {
        id: 'h1',
        name: 'github',
        enabled: true,
        config: {
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      },
      {
        id: 'h2',
        name: 'plain',
        enabled: true,
        config: { transport: 'http', url: 'https://example.com/x', headers: {} },
      },
    ]);
    expect(servers?.['github']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    const plain = servers?.['plain'];
    expect(plain).toEqual({ type: 'http', url: 'https://example.com/x' });
    expect(plain && 'headers' in plain).toBe(false);
  });

  test('sse SETS type=sse', () => {
    const servers = toSdkMcpServers([
      {
        id: 's1',
        name: 'legacy',
        enabled: true,
        config: {
          transport: 'sse',
          url: 'https://example.com/sse',
          headers: { 'X-Key': 'abc' },
        },
      },
    ]);
    expect(servers?.['legacy']).toEqual({
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-Key': 'abc' },
    });
  });

  test('a later duplicate name wins (last write to the record key)', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'dup', true, { args: ['first'] }),
      stdio('b', 'dup', true, { args: ['second'] }),
    ]);
    expect(Object.keys(servers ?? {})).toEqual(['dup']);
    expect(servers?.['dup']).toEqual({ command: 'npx', args: ['second'] });
  });
});

describe('SessionRunner — policy deny list → SDK disallowedTools (sec-22ee938b)', () => {
  test('a deny entry appears in SDK disallowedTools even under bypassPermissions', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 2,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'bypassPermissions',
        permissionPolicy: { allow: [], deny: ['Bash'], mode: 'bypassPermissions' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
      },
      () => {},
    );

    await runner.run();

    expect(queryCalls).toBe(1);
    const disallowed = lastQueryOptions?.disallowedTools as string[] | undefined;
    expect(disallowed).toBeDefined();
    expect(disallowed).toContain('Bash');
  });

  test('deny list unions with preset disallowedTools without duplication', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 3,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'bypassPermissions',
        permissionPolicy: { allow: [], deny: ['Bash', 'Edit'], mode: 'bypassPermissions' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        // Preset already contains Bash — the union must not duplicate it.
        disallowedTools: ['Bash', 'Write'],
      },
      () => {},
    );

    await runner.run();

    expect(queryCalls).toBe(1);
    const disallowed = lastQueryOptions?.disallowedTools as string[] | undefined;
    expect(disallowed).toBeDefined();
    // All three tools present, no duplicates.
    expect(disallowed?.sort()).toEqual(['Bash', 'Edit', 'Write']);
  });

  test('an empty deny list does not affect preset disallowedTools', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 4,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'bypassPermissions',
        permissionPolicy: { allow: [], deny: [], mode: 'bypassPermissions' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        disallowedTools: ['Write'],
      },
      () => {},
    );

    await runner.run();

    expect(queryCalls).toBe(1);
    const disallowed = lastQueryOptions?.disallowedTools as string[] | undefined;
    expect(disallowed).toEqual(['Write']);
  });

  test('empty deny list and no preset omits disallowedTools from SDK options', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 5,
        prompt: 'hi',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        permissionPolicy: { allow: [], deny: [], mode: 'default' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
      },
      () => {},
    );

    await runner.run();

    expect(queryCalls).toBe(1);
    expect(lastQueryOptions).toBeDefined();
    expect('disallowedTools' in (lastQueryOptions ?? {})).toBe(false);
  });
});

describe('SessionRunner — curated subprocess env (no wholesale process.env)', () => {
  test('strips unrelated secrets, keeps PATH, applies the tasks toggle', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    // A secret that happens to live in the desktop app's env must NOT reach the
    // agent subprocess; PATH (a runtime essential) must.
    const prev = process.env.NIGHTCORE_TEST_FAKE_SECRET;
    process.env.NIGHTCORE_TEST_FAKE_SECRET = 'leak-me';
    try {
      const runner = new SessionRunner(
        {
          sessionId: 6,
          prompt: 'hi',
          model: 'claude-opus-4-8',
          permissionMode: 'bypassPermissions',
          permissionPolicy: { allow: [], deny: [], mode: 'bypassPermissions' },
          cwd: process.cwd(),
          apiKeyFallback: false,
          settingSources,
          todoFeatureEnabled: true,
        },
        () => {},
      );

      await runner.run();

      expect(queryCalls).toBe(1);
      const env = lastQueryOptions?.env as Record<string, string> | undefined;
      expect(env).toBeDefined();
      expect(env?.NIGHTCORE_TEST_FAKE_SECRET).toBeUndefined();
      expect(env?.PATH).toBe(process.env.PATH);
      // The tasks toggle is applied as an override.
      expect(env?.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
    } finally {
      if (prev === undefined) delete process.env.NIGHTCORE_TEST_FAKE_SECRET;
      else process.env.NIGHTCORE_TEST_FAKE_SECRET = prev;
    }
  });
});

describe('composeAppendSystemPrompt — Pre-flight Context Pack (Lock, feature #4)', () => {
  const persona = 'You are an independent code reviewer.';
  const pack = 'PROJECT CONSTITUTION: never break the folder-per-component rule.';

  const root = '# Working directory (authoritative)\n\n  /repo/wt';

  test('orders the working root BEFORE the pack, and the pack BEFORE the persona', () => {
    const composed = composeAppendSystemPrompt(root, pack, persona);
    expect(composed).toBeDefined();
    expect(composed!.indexOf(root)).toBe(0);
    expect(composed!.indexOf(root)).toBeLessThan(composed!.indexOf(pack));
    expect(composed!.indexOf(pack)).toBeLessThan(composed!.indexOf(persona));
  });

  test('orders the context pack BEFORE the kind-preset persona (no working root)', () => {
    const composed = composeAppendSystemPrompt(undefined, pack, persona);
    expect(composed).toBeDefined();
    const packAt = composed!.indexOf(pack);
    const personaAt = composed!.indexOf(persona);
    expect(packAt).toBe(0);
    expect(packAt).toBeLessThan(personaAt);
  });

  test('returns just the pack when there is no working root or persona', () => {
    expect(composeAppendSystemPrompt(undefined, pack, undefined)).toBe(pack);
  });

  test('returns just the persona when there is no working root or pack', () => {
    expect(composeAppendSystemPrompt(undefined, undefined, persona)).toBe(persona);
    expect(composeAppendSystemPrompt(undefined, '   ', persona)).toBe(persona);
  });

  test('returns undefined when every part is absent (omits the SDK option)', () => {
    expect(composeAppendSystemPrompt(undefined, undefined, undefined)).toBeUndefined();
    expect(composeAppendSystemPrompt('', '', '')).toBeUndefined();
  });

  test('truncates an oversized pack to the budget with a notice', () => {
    const huge = 'x'.repeat(CONTEXT_PACK_MAX_CHARS + 5000);
    const composed = composeAppendSystemPrompt(undefined, huge, persona);
    expect(composed).toBeDefined();
    // The bounded pack is at most the budget plus the short truncation notice, and
    // is far shorter than the raw input — it cannot crowd out the task.
    expect(composed!.length).toBeLessThan(huge.length);
    expect(composed).toContain('truncated');
    // The persona still survives at the end (the pack didn't swallow it).
    expect(composed!.endsWith(persona)).toBe(true);
  });
});

describe('SessionRunner — appendContextPack composes into SDK appendSystemPrompt', () => {
  test('the working root leads, then the context pack, then the persona', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 6,
        prompt: 'build it',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        permissionPolicy: { allow: [], deny: [], mode: 'default' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        // The trusted pack the Rust core would assemble + the reviewer persona.
        appendSystemPrompt: 'You are an independent code reviewer.',
        appendContextPack: 'PROJECT CONSTITUTION: keep tests green.',
      },
      () => {},
    );

    await runner.run();

    expect(queryCalls).toBe(1);
    const appended = lastQueryOptions?.appendSystemPrompt as string | undefined;
    expect(appended).toBeDefined();
    // The authoritative working-directory directive leads and names the run cwd.
    expect(appended!.startsWith('# Working directory (authoritative)')).toBe(true);
    expect(appended).toContain(process.cwd());
    const directiveAt = appended!.indexOf('Working directory (authoritative)');
    const packAt = appended!.indexOf('PROJECT CONSTITUTION');
    const personaAt = appended!.indexOf('independent code reviewer');
    expect(directiveAt).toBeLessThan(packAt);
    expect(packAt).toBeLessThan(personaAt);
  });

  test('with no pack, the working-root directive still leads the persona', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    lastQueryOptions = undefined;

    const runner = new SessionRunner(
      {
        sessionId: 7,
        prompt: 'build it',
        model: 'claude-opus-4-8',
        permissionMode: 'default',
        permissionPolicy: { allow: [], deny: [], mode: 'default' },
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: 'PERSONA ONLY',
      },
      () => {},
    );

    await runner.run();

    const appended = lastQueryOptions?.appendSystemPrompt as string | undefined;
    expect(appended!.startsWith('# Working directory (authoritative)')).toBe(true);
    expect(appended!.endsWith('PERSONA ONLY')).toBe(true);
  });
});
