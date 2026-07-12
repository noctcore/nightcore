/// <reference types="bun" />
import { afterAll, describe, expect, mock, test } from 'bun:test';

import type {
  McpServerEntry,
  NightcoreEvent,
  PermissionPolicy,
  SettingSource,
} from '@nightcore/contracts';

// bun's `mock.module` is a PROCESS-GLOBAL, permanent registry override with no
// built-in un-mock, so a partial stub here would leak into any later test file
// that imports the real module (notably `resolve-claude-binary.test.ts`, which
// asserts the real memoization). Capture the real module before stubbing and
// re-register it in afterAll so this file's stub is scoped to this file.
const realResolveClaudeBinary = { ...(await import('./resolve-claude-binary.js')) };
afterAll(() => {
  mock.module('./resolve-claude-binary.js', () => realResolveClaudeBinary);
});

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
/** When true, the stubbed query's control methods (`interrupt`/`setModel`/
 *  `setPermissionMode`) REJECT — reproducing a control request that fails because
 *  the session is mid-teardown or the transport is closed. Each control method
 *  must swallow that and degrade to a no-op rather than throwing. */
let rejectControl = false;
/** When set, `query()` THROWS on open — reproducing a transient probe subprocess
 *  that can't be spawned. `withProbe` must return the fallback, not reject. */
let throwOnQuery = false;
/** When > 0, the NEXT this-many `query()` opens throw (then succeed) —
 *  reproducing a TRANSIENT spawn blip the probe retry (issue #252) must recover
 *  from. Decrements per throwing open. */
let failNextQueryOpens = 0;
/** When true, the stubbed query's provider-config read methods (`supportedModels`
 *  et al.) REJECT — reproducing a body-call failure mid-probe. `withProbe` must
 *  still run its teardown (abort + interrupt) and return the fallback. */
let rejectProbeRead = false;
/** When > 0, the NEXT this-many `supportedModels()` reads REJECT (then succeed) —
 *  reproducing a TRANSIENT read blip the probe retry (issue #252) must recover
 *  from. Decrements per rejecting read. */
let failNextProbeReads = 0;
/** Scripted return value for the stubbed `supportedModels()` control read. */
let scriptedModels: unknown[] = [];
/** When true, the stubbed query's first exhausted `next()` PARKS a plan-mode
 *  `ExitPlanMode` approval through the runner's own `canUseTool`, then wedges until
 *  teardown aborts — reproducing a run sitting at `waiting_approval`. The idle
 *  watchdog must NEVER auto-fail this run (T6 #147: a parked plan waits indefinitely
 *  for a human decision). Distinct from `stallStream`, which wedges with NO pending
 *  approval (a genuine crash the watchdog SHOULD trip). */
let parkPlanThenStall = false;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: { options?: Record<string, unknown> }) => {
    queryCalls += 1;
    lastQueryOptions = args?.options;
    // A transient probe subprocess that fails to spawn: withProbe must degrade to
    // its fallback, not reject.
    if (throwOnQuery) throw new Error('transient probe failed to open');
    // A TRANSIENT spawn blip that clears on retry (issue #252).
    if (failNextQueryOpens > 0) {
      failNextQueryOpens -= 1;
      throw new Error('transient probe open blipped');
    }
    const pending = [...queuedMessages];
    const iterator: AsyncGenerator<unknown> = {
      async next() {
        const value = pending.shift();
        if (value === undefined && parkPlanThenStall) {
          // Park a plan-mode approval (fire-and-forget — it stays pending until a
          // surface decides), then wedge until teardown aborts. This is exactly the
          // shape of a run parked at `waiting_approval`: the SDK is blocked awaiting
          // `canUseTool`, so it stops yielding — the state the idle watchdog must NOT
          // treat as a stall. The wedge resolves on abort so the run can terminate.
          const opts = args?.options as
            | {
                canUseTool?: (t: string, i: unknown, o: { signal: AbortSignal }) => unknown;
                abortController?: AbortController;
              }
            | undefined;
          const signal = opts?.abortController?.signal ?? new AbortController().signal;
          void opts?.canUseTool?.('ExitPlanMode', { plan: 'Step 1: do X' }, { signal });
          return new Promise<IteratorResult<unknown>>((resolve) => {
            if (signal.aborted) {
              resolve({ value: undefined, done: true });
              return;
            }
            signal.addEventListener(
              'abort',
              () => resolve({ value: undefined, done: true }),
              { once: true },
            );
          });
        }
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
        if (rejectControl) throw new Error('interrupt rejected: transport closed');
      },
      async setModel() {
        if (rejectControl) throw new Error('setModel rejected: session stopping');
      },
      async setPermissionMode() {
        if (rejectControl) throw new Error('setPermissionMode rejected: session stopping');
      },
      // Provider-config inspector control reads. `supportedModels` is the template
      // the whole probe surface (mcpServerStatus/supportedCommands/…) shares.
      async supportedModels() {
        if (rejectProbeRead) throw new Error('probe read rejected mid-flight');
        // A TRANSIENT read blip that clears on retry (issue #252).
        if (failNextProbeReads > 0) {
          failNextProbeReads -= 1;
          throw new Error('probe read blipped');
        }
        return scriptedModels;
      },
      async mcpServerStatus() {
        return [] as unknown[];
      },
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

  test('a run parked on a plan (pending approval) is NEVER idle-failed (T6 #147)', async () => {
    // The T6 guarantee's engine half: a plan sitting at `waiting_approval` blocks the
    // SDK on `canUseTool`, so the stream stops yielding — but that is a human wait,
    // NOT a wedge. The idle watchdog must re-arm indefinitely, never emitting a
    // session-failed that would effectively auto-reject the parked plan.
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    parkPlanThenStall = true;
    queuedMessages = [];
    const events: NightcoreEvent[] = [];

    const runner = new SessionRunner(
      {
        sessionId: 44,
        prompt: 'plan this',
        model: 'claude-opus-4-8',
        permissionMode: 'plan',
        permissionPolicy: policy,
        cwd: process.cwd(),
        apiKeyFallback: false,
        settingSources,
        todoFeatureEnabled: false,
        // A tiny deadline so many windows elapse fast; without the exclusion the
        // watchdog would trip on the FIRST window (~15ms).
        idleTimeoutMs: 15,
      },
      (e) => events.push(e),
    );

    // A parked plan never terminates on its own — start the run, do NOT await it.
    const runPromise = runner.run();

    // Let ~10 idle windows elapse. If the exclusion were missing, the watchdog would
    // have fired several times over and emitted session-failed(stalled).
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The plan parked (a permission-required surfaced) and the idle watchdog did NOT
    // auto-fail the waiting run despite the many elapsed windows.
    expect(events.some((e) => e.type === 'permission-required')).toBe(true);
    expect(events.some((e) => e.type === 'session-failed')).toBe(false);

    // Tear down so the test terminates: interrupt aborts the query, which settles the
    // parked approval and resolves the wedge — a normal (non-stall) end.
    await runner.interrupt();
    await runPromise;
    parkPlanThenStall = false;

    // Teardown produced no phantom "stalled" failure either.
    expect(
      events.some((e) => e.type === 'session-failed' && e.message.includes('stalled')),
    ).toBe(false);
    // The parked run was torn down on interrupt, not leaked.
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

describe('SessionRunner — control requests degrade when the SDK rejects', () => {
  // interrupt() already awaits behind a .catch(); setModel()/setPermissionMode()
  // must mirror it. A rejected control request (session mid-teardown / closed
  // transport) has to degrade to a no-op, not bubble up as an unhandled rejection
  // that the sidecar can only report as a generic 'dispatch failed'.
  async function runnerWithLiveQuery(): Promise<InstanceType<typeof SessionRunner>> {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    queuedMessages = [];
    const runner = makeRunner(() => {});
    // run() completes on the empty stream but leaves `this.query` assigned, so the
    // control methods proxy to the (now settled) stubbed Query.
    await runner.run();
    expect(queryCalls).toBe(1);
    return runner;
  }

  test('setModel swallows a rejected control request', async () => {
    const runner = await runnerWithLiveQuery();
    rejectControl = true;
    try {
      await expect(runner.setModel('claude-sonnet-4-5')).resolves.toBeUndefined();
    } finally {
      rejectControl = false;
    }
  });

  test('setPermissionMode swallows a rejected control request', async () => {
    const runner = await runnerWithLiveQuery();
    rejectControl = true;
    try {
      await expect(runner.setPermissionMode('acceptEdits')).resolves.toBeUndefined();
    } finally {
      rejectControl = false;
    }
  });

  test('interrupt swallows a rejected control request', async () => {
    const runner = await runnerWithLiveQuery();
    rejectControl = true;
    interruptCalls = 0;
    try {
      await expect(runner.interrupt()).resolves.toBeUndefined();
      // The control request WAS issued (and rejected) — it did not silently skip.
      expect(interruptCalls).toBe(1);
    } finally {
      rejectControl = false;
    }
  });
});

describe('SessionRunner — live-control probe surface (transient-probe teardown)', () => {
  // The provider-config inspector reads the SDK's model list / MCP status /
  // skills / subagents / init off `withProbe`. Its `finally` (abort + interrupt)
  // is the SOLE guard against leaking a `claude` subprocess on every inspection.
  // These exercise the REAL transient spawn-and-teardown, not a stubbed withProbe.

  /** The AbortController the transient probe was spawned with, read off the last
   *  `query()` options — its `.signal.aborted` proves `abort.abort()` ran. */
  function lastAbort(): AbortController {
    return lastQueryOptions?.abortController as AbortController;
  }

  test('with NO live query, supportedModels spawns a transient probe and tears it down', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    lastQueryOptions = undefined;
    scriptedModels = [{ value: 'claude-opus-4-8', displayName: 'Opus' }];

    // A fresh runner has never opened a query, so this MUST take the transient path.
    const runner = makeRunner(() => {});
    const models = await runner.supportedModels();

    // The scripted control read flowed back through the real probeControl/withProbe.
    expect(models).toEqual(scriptedModels);
    // Exactly one transient subprocess was spawned for the probe...
    expect(queryCalls).toBe(1);
    // ...and torn down in the finally: abort.abort() fired AND interrupt() ran, so
    // no claude subprocess leaks. This is the subprocess-leak guard under test.
    expect(lastAbort().signal.aborted).toBe(true);
    expect(interruptCalls).toBe(1);
  });

  test('an OPEN failure retries then degrades to the fallback without throwing', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    failNextQueryOpens = 0;
    scriptedModels = [{ value: 'm' }];
    throwOnQuery = true;
    try {
      const runner = makeRunner(() => {});
      // Degrade-not-throw: an open that fails EVERY attempt resolves to `[]`.
      await expect(runner.supportedModels()).resolves.toEqual([]);
      // Issue #252: the transient probe is retried (1 initial + 2 retries) before
      // degrading, instead of masking the first blip as an empty list.
      expect(queryCalls).toBe(3);
      // The transient never opened on any attempt, so there is nothing to interrupt.
      expect(interruptCalls).toBe(0);
    } finally {
      throwOnQuery = false;
    }
  });

  test('a body-throw retries, tears each transient down, and degrades to the fallback', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    lastQueryOptions = undefined;
    failNextProbeReads = 0;
    rejectProbeRead = true;
    try {
      const runner = makeRunner(() => {});
      await expect(runner.supportedModels()).resolves.toEqual([]);
      // Each of the 3 attempts opens a transient and tears it down on the failed
      // read — a failing read must never leak the subprocess it was reading from.
      expect(queryCalls).toBe(3);
      expect(lastAbort().signal.aborted).toBe(true);
      expect(interruptCalls).toBe(3);
    } finally {
      rejectProbeRead = false;
    }
  });

  test('a TRANSIENT open blip is retried and recovers the real model list (issue #252)', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    lastQueryOptions = undefined;
    scriptedModels = [{ value: 'claude-opus-4-8', displayName: 'Opus' }];
    // The FIRST open fails; the retry opens cleanly and reads the real list.
    failNextQueryOpens = 1;
    try {
      const runner = makeRunner(() => {});
      const models = await runner.supportedModels();
      // Previously this single blip degraded to `[]`; now the retry recovers it.
      expect(models).toEqual(scriptedModels);
      // One failed open + one successful open = 2 spawns; the successful one is
      // torn down in finally.
      expect(queryCalls).toBe(2);
      expect(interruptCalls).toBe(1);
    } finally {
      failNextQueryOpens = 0;
    }
  });

  test('a TRANSIENT read blip is retried and recovers the real model list (issue #252)', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    scriptedModels = [{ value: 'reads-recover' }];
    // The FIRST read rejects; the retry opens a fresh probe and reads cleanly.
    failNextProbeReads = 1;
    try {
      const runner = makeRunner(() => {});
      const models = await runner.supportedModels();
      expect(models).toEqual(scriptedModels);
      // Two attempts, each opening AND tearing down its own transient probe.
      expect(queryCalls).toBe(2);
      expect(interruptCalls).toBe(2);
    } finally {
      failNextProbeReads = 0;
    }
  });

  test('with a live query and no cwd override, withProbe REUSES it (no new subprocess)', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    queuedMessages = [];
    scriptedModels = [{ value: 'reused' }];

    // Drive run() to completion so `this.query` is assigned (never nulled), giving
    // the runner a live query to reuse.
    const runner = makeRunner(() => {});
    await runner.run();
    expect(queryCalls).toBe(1);

    const models = await runner.supportedModels();

    // Reuse path: the read went to the existing query — NO transient was spawned...
    expect(models).toEqual(scriptedModels);
    expect(queryCalls).toBe(1);
    // ...and the shared live query is NOT torn down by the probe.
    expect(interruptCalls).toBe(0);
  });

  test('a cwd override FORCES a transient probe even when a live query exists', async () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    queryCalls = 0;
    interruptCalls = 0;
    queuedMessages = [];
    lastQueryOptions = undefined;

    const runner = makeRunner(() => {});
    await runner.run();
    expect(queryCalls).toBe(1);

    // The live query is rooted at this runner's own cwd; a cwd override must
    // re-root resolution, which the live query can't do — so it forces a transient.
    const status = await runner.mcpServerStatus('/other/project/root');

    expect(status).toEqual([]);
    expect(queryCalls).toBe(2);
    // The transient was spawned at the override root and torn down afterwards.
    expect(lastQueryOptions?.cwd).toBe('/other/project/root');
    expect(lastAbort().signal.aborted).toBe(true);
    expect(interruptCalls).toBe(1);
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
