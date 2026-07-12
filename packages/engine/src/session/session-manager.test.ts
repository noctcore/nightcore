/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { Config, HarnessPolicy, NightcoreEvent } from '@nightcore/contracts';

import type {
  AgentProvider,
  AgentSession,
  PreflightRequest,
  StartSessionParams,
} from '../providers/agent-provider.js';
import {
  assertGovernanceInvariant,
  assertHooksInvariant,
} from '../providers/agent-provider.js';
import {
  autonomyToPermissionMode,
  CLAUDE_CAPABILITIES,
} from '../providers/claude/capabilities.js';
import type { ProviderRegistry } from '../providers/provider-factory.js';

/**
 * The SDK boundary is stubbed so no live Claude model is ever spawned. Each
 * fake `query()` call pulls the next scripted message script from `nextScript`,
 * exposing a controllable async-iterable plus the control methods the runner
 * proxies to (`interrupt`/`setModel`/`setPermissionMode`).
 */
type Script =
  | { kind: 'messages'; messages: unknown[] }
  | { kind: 'throw'; error: unknown }
  // Yields `messages` then blocks forever on the next pull, so the session stays
  // live (never drains → never retires) — lets a test dispatch a follow-up
  // command against an in-flight session.
  | { kind: 'hang'; messages: unknown[] };

let scripts: Script[] = [];
const interruptCalls: number[] = [];
/** Every `Options` object the engine handed to `query()`, in call order, so a
 *  test can assert the kind preset threaded the right tool/prompt restrictions. */
const queryOptions: Record<string, unknown>[] = [];

function makeFakeQuery() {
  const script = scripts.shift() ?? { kind: 'messages', messages: [] };
  let index = 0;
  const iterator: AsyncGenerator<unknown> = {
    async next() {
      if (script.kind === 'throw') {
        throw script.error;
      }
      if (index >= script.messages.length) {
        // A `hang` script blocks the pull forever so the session never retires.
        if (script.kind === 'hang') return new Promise<never>(() => {});
        return { value: undefined, done: true };
      }
      return { value: script.messages[index++], done: false };
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
      interruptCalls.push(1);
    },
    async setModel() {},
    async setPermissionMode() {},
  });
}

// Controllable stubs for the SDK session-store functions (`handleQuery` reads
// these), so no real `~/.claude/projects` disk access happens in the test.
const sessionFnStubs = {
  listSessions: mock(() => Promise.resolve<unknown[]>([])),
  getSessionInfo: mock(() => Promise.resolve<unknown>(undefined)),
  getSessionMessages: mock(() => Promise.resolve<unknown[]>([])),
  renameSession: mock(() => Promise.resolve<unknown>(undefined)),
  tagSession: mock(() => Promise.resolve<unknown>(undefined)),
};

// Spread the real module so all other named exports the engine pulls (`tool`,
// `createSdkMcpServer`, …) still resolve; override `query` (no live model) and the
// session-store functions (no disk reads) so the test is hermetic.
const realSdk = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  ...sessionFnStubs,
  query: (args: { options?: Record<string, unknown> }) => {
    if (args?.options) queryOptions.push(args.options);
    return makeFakeQuery();
  },
}));

// Fully stub the Claude-CLI resolver so the test never depends on a `claude`
// being installed on the host. `SessionRunner.runQueryLoop()` runs a preflight:
// if `resolveClaudeBinary()` returns undefined it emits a "Claude CLI not found"
// `session-failed` and returns BEFORE reaching the mocked `query()` — which on a
// machine without the CLI (e.g. CI) would break every mock-driven test here
// (the crash assertion gets the CLI-missing message; the happy-path tests time
// out waiting for a `session-completed` that never comes). Returning a fixed fake
// path makes the preflight pass so the tests exercise the scripted `query()`
// seam. `checkClaudeCliVersion` is stubbed to `undefined` too: its real body
// `spawnSync`s `<binary> --version`, so leaving it live would spawn a real
// subprocess — this keeps the suite fully hermetic (no CLI, no child process).
// bun's `mock.module` is a permanent, process-global override; capture the real
// module first and re-register it in afterAll so this partial stub can't leak
// into `providers/claude/resolve-claude-binary.test.ts` (which asserts the real
// memoization) when it runs after this file.
const realResolveClaudeBinary = {
  ...(await import('../providers/claude/resolve-claude-binary.js')),
};
afterAll(() => {
  mock.module(
    '../providers/claude/resolve-claude-binary.js',
    () => realResolveClaudeBinary,
  );
});
mock.module('../providers/claude/resolve-claude-binary.js', () => ({
  resolveClaudeBinary: () => '/usr/local/bin/claude',
  checkClaudeCliVersion: () => undefined,
}));

// Imported AFTER the mock is registered so the runner picks up the stub.
const { SessionManager } = await import('./session-manager.js');

let tmp: string;

function makeConfig(): Config {
  const home = path.join(tmp, 'home');
  return {
    model: 'claude-opus-4-8',
    permissions: { allow: [], deny: [], mode: 'default' },
    settingSources: ['user', 'project', 'local'],
    todoFeatureEnabled: true,
    maxTurns: 200,
    paths: { home, sessions: path.join(home, 'sessions') },
    logLevel: 'silent',
  };
}

/** A scripted `result: success` SDK message. */
function successMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0.01,
    num_turns: 1,
    duration_ms: 10,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function initMessage(): unknown {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-uuid',
    model: 'claude-opus-4-8',
    tools: [],
  };
}

/** Collect events and resolve once an event matching `until` arrives. */
function collect(
  manager: InstanceType<typeof SessionManager>,
  until: (e: NightcoreEvent) => boolean,
): { events: NightcoreEvent[]; done: Promise<void> } {
  const events: NightcoreEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  manager.on((event) => {
    events.push(event);
    if (until(event)) resolve();
  });
  return { events, done };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-sm-'));
  scripts = [];
  interruptCalls.length = 0;
  queryOptions.length = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SessionManager happy path', () => {
  test('emits started → ready → completed for a successful session', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { events, done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({ type: 'start-session', prompt: 'hi' });
    await done;

    const types = events.map((e) => e.type);
    expect(types).toContain('session-started');
    expect(types).toContain('session-ready');
    expect(types).toContain('session-completed');
  });

  test('persists a session record to disk', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');
    await manager.dispatch({ type: 'start-session', prompt: 'persist me' });
    await done;

    const indexFile = path.join(tmp, 'home', 'sessions', 'index.jsonl');
    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.readFileSync(indexFile, 'utf8')).toContain('persist me');
  });
});

describe('SessionManager monotonic ids', () => {
  test('hands out climbing ids that never reset across sessions', async () => {
    scripts = [
      { kind: 'messages', messages: [successMessage()] },
      { kind: 'messages', messages: [successMessage()] },
      { kind: 'messages', messages: [successMessage()] },
    ];
    const manager = new SessionManager(makeConfig());
    const started: number[] = [];
    let completed = 0;
    let resolve!: () => void;
    const allDone = new Promise<void>((r) => (resolve = r));
    manager.on((e) => {
      if (e.type === 'session-started') started.push(e.sessionId);
      if (e.type === 'session-completed' && ++completed === 3) resolve();
    });

    await manager.dispatch({ type: 'start-session', prompt: 'a' });
    await manager.dispatch({ type: 'start-session', prompt: 'b' });
    await manager.dispatch({ type: 'start-session', prompt: 'c' });
    await allDone;

    expect(started).toEqual([1, 2, 3]);
    // Strictly increasing, no reuse.
    expect(new Set(started).size).toBe(3);
  });
});

describe('SessionManager degrade-not-throw', () => {
  test('a runner crash surfaces as session-failed and never rejects dispatch', async () => {
    scripts = [{ kind: 'throw', error: new Error('sdk exploded') }];
    const manager = new SessionManager(makeConfig());
    const { events, done } = collect(manager, (e) => e.type === 'session-failed');

    // dispatch must resolve (never reject) even though the runner crashes.
    await expect(
      manager.dispatch({ type: 'start-session', prompt: 'boom' }),
    ).resolves.toBeUndefined();
    await done;

    const failed = events.find((e) => e.type === 'session-failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'session-failed') {
      expect(failed.reason).toBe('runner-crash');
      expect(failed.message).toContain('sdk exploded');
    }
  });

  test('the manager retires a crashed session (activeCount returns to 0)', async () => {
    scripts = [{ kind: 'throw', error: new Error('crash') }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-failed');
    await manager.dispatch({ type: 'start-session', prompt: 'x' });
    await done;
    // retire() runs in the run().finally microtask; flush it.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.activeCount).toBe(0);
  });

  test('a command for an unknown session id is dropped, not thrown', async () => {
    const manager = new SessionManager(makeConfig());
    await expect(
      manager.dispatch({ type: 'interrupt', sessionId: 9999 }),
    ).resolves.toBeUndefined();
  });
});

describe('SessionManager late-event dropping', () => {
  test('after a session retires, a completed terminal still routes cleanly', async () => {
    // A session that completes then has its runner fully torn down. A second
    // start gets a fresh id; the first id is never reused, so any late event
    // bearing id 1 after retirement is dropped by the monotonic-id guard.
    scripts = [
      { kind: 'messages', messages: [successMessage()] },
      { kind: 'messages', messages: [successMessage()] },
    ];
    const manager = new SessionManager(makeConfig());
    const startedIds: number[] = [];
    let completed = 0;
    let resolve!: () => void;
    const twoDone = new Promise<void>((r) => (resolve = r));
    manager.on((e) => {
      if (e.type === 'session-started') startedIds.push(e.sessionId);
      if (e.type === 'session-completed' && ++completed === 2) resolve();
    });

    await manager.dispatch({ type: 'start-session', prompt: 'first' });
    await manager.dispatch({ type: 'start-session', prompt: 'second' });
    await twoDone;
    // retire() runs in each run().finally microtask; flush before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(startedIds).toEqual([1, 2]);
    expect(manager.activeCount).toBe(0);
  });
});

describe('SessionManager task kinds (M4)', () => {
  test('a kind-less start-session runs unchanged with no tool restrictions', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({ type: 'start-session', prompt: 'build it' });
    await done;

    const options = queryOptions.at(-1)!;
    // The build preset adds no PERSONA and no allow restriction, and permissionMode
    // falls back to the session default. `appendSystemPrompt` still carries the
    // always-present working-root directive (worktree isolation). It DOES deny web
    // egress (WebFetch/WebSearch) by default so a bypass run can't exfil via a GET.
    expect(options.appendSystemPrompt).toContain('Working directory (authoritative)');
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toEqual(['WebFetch', 'WebSearch']);
    expect(options.permissionMode).toBe('default');
  });

  test("kind:'review' denies the write tools and runs non-prompting", async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({
      type: 'start-session',
      prompt: 'review the diff',
      kind: 'review',
    });
    await done;

    const options = queryOptions.at(-1)!;
    const denied = options.disallowedTools as string[];
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
      expect(denied).toContain(tool);
    }
    expect(options.appendSystemPrompt).toBeDefined();
    // Verification is unattended: a review never prompts.
    expect(options.permissionMode).toBe('dontAsk');
  });

  test('an explicit command.permissionMode overrides the kind default', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({
      type: 'start-session',
      prompt: 'review the diff',
      kind: 'review',
      autonomy: 'plan',
    });
    await done;

    // The review preset defaults to `dontAsk`, but an explicit command autonomy
    // wins (lowered to the SDK `plan` mode at the provider boundary).
    expect(queryOptions.at(-1)!.permissionMode).toBe('plan');
  });
});

describe('SessionManager autonomy ceilings (maxTurns/maxBudgetUsd)', () => {
  test('a session inherits the config maxTurns default and no budget cap', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({ type: 'start-session', prompt: 'go' });
    await done;

    const options = queryOptions.at(-1)!;
    expect(options.maxTurns).toBe(200);
    // Uncapped by default — the option is omitted, not set to a number.
    expect(options.maxBudgetUsd).toBeUndefined();
  });

  test('a per-task maxTurns/maxBudgetUsd override wins over the config default', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({
      type: 'start-session',
      prompt: 'bounded run',
      maxTurns: 5,
      maxBudgetUsd: 2.5,
    });
    await done;

    const options = queryOptions.at(-1)!;
    expect(options.maxTurns).toBe(5);
    expect(options.maxBudgetUsd).toBe(2.5);
  });

  test('a configured maxBudgetUsd default is applied when no override is given', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const config = { ...makeConfig(), maxBudgetUsd: 10 };
    const manager = new SessionManager(config);
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({ type: 'start-session', prompt: 'capped' });
    await done;

    expect(queryOptions.at(-1)!.maxBudgetUsd).toBe(10);
  });
});

describe('SessionManager id-counter seeding (restart safety)', () => {
  /** Write session records straight to the store file the manager will read, to
   *  simulate a prior process having persisted them before this launch. */
  function seedStore(records: { id: number; createdAt?: number }[]): void {
    const sessionsDir = path.join(tmp, 'home', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const lines = records
      .map((r) =>
        JSON.stringify({
          id: r.id,
          prompt: 'prior',
          model: 'claude-opus-4-8',
          permissionMode: 'default',
          cwd: '/work',
          status: 'completed',
          createdAt: r.createdAt ?? 1000,
        }),
      )
      .join('\n');
    fs.writeFileSync(path.join(sessionsDir, 'index.jsonl'), `${lines}\n`, 'utf8');
  }

  test('seeds the next id past the highest persisted record id on restart', async () => {
    // Pre-fix the counter always restarted at 1, so this new session would reuse
    // id 5 and clobber the persisted record. It must instead get id 6.
    seedStore([{ id: 3 }, { id: 5 }, { id: 2 }]);
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const started: number[] = [];
    const { done } = collect(manager, (e) => e.type === 'session-completed');
    manager.on((e) => {
      if (e.type === 'session-started') started.push(e.sessionId);
    });

    await manager.dispatch({ type: 'start-session', prompt: 'after restart' });
    await done;

    expect(started).toEqual([6]);
  });

  test('cold start (no persisted records) still begins at id 1', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const started: number[] = [];
    const { done } = collect(manager, (e) => e.type === 'session-completed');
    manager.on((e) => {
      if (e.type === 'session-started') started.push(e.sessionId);
    });

    await manager.dispatch({ type: 'start-session', prompt: 'fresh boot' });
    await done;

    expect(started).toEqual([1]);
  });

  test('a restart does not overwrite the prior record at the reused id', async () => {
    // Concrete clobber check: persist id 1, restart, run a session. Post-fix the
    // new session is id 2 and the original id-1 record survives in the store.
    seedStore([{ id: 1 }]);
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');
    await manager.dispatch({ type: 'start-session', prompt: 'second boot' });
    await done;

    const indexFile = path.join(tmp, 'home', 'sessions', 'index.jsonl');
    const contents = fs.readFileSync(indexFile, 'utf8');
    // The original record (its prompt) is still present — not clobbered.
    expect(contents).toContain('prior');
    expect(contents).toContain('second boot');
  });
});

describe('SessionManager session resume', () => {
  test('omits resume when no session id is supplied (cold start)', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({ type: 'start-session', prompt: 'fresh' });
    await done;

    expect(queryOptions.at(-1)!.resume).toBeUndefined();
  });

  test('sets Options.resume when a resumeSessionId is supplied', async () => {
    scripts = [{ kind: 'messages', messages: [initMessage(), successMessage()] }];
    const manager = new SessionManager(makeConfig());
    const { done } = collect(manager, (e) => e.type === 'session-completed');

    await manager.dispatch({
      type: 'start-session',
      prompt: 'reattach',
      resumeSessionId: 'sdk-uuid-prior',
    });
    await done;

    expect(queryOptions.at(-1)!.resume).toBe('sdk-uuid-prior');
  });
});

describe('SessionManager.handleQuery — SDK session store', () => {
  beforeEach(() => {
    for (const stub of Object.values(sessionFnStubs)) stub.mockClear();
  });

  test('list-sessions maps SDK SDKSessionInfo to the wire SessionInfo and echoes requestId', async () => {
    sessionFnStubs.listSessions.mockImplementationOnce(() =>
      Promise.resolve([
        {
          sessionId: 'sdk-uuid-1',
          summary: 'A run',
          lastModified: 123,
          gitBranch: 'nc/task-1',
          cwd: '/proj/wt/task-1',
        },
      ]),
    );
    const manager = new SessionManager(makeConfig());
    const result = await manager.handleQuery({
      type: 'list-sessions',
      requestId: 'q1',
      dir: '/proj',
    });
    expect(result).toEqual({
      type: 'query-result',
      requestId: 'q1',
      ok: true,
      kind: 'sessions',
      sessions: [
        {
          // The SDK `sessionId` is renamed `sdkSessionId` on the wire.
          sdkSessionId: 'sdk-uuid-1',
          summary: 'A run',
          lastModified: 123,
          gitBranch: 'nc/task-1',
          cwd: '/proj/wt/task-1',
        },
      ],
    });
    // The dir/limit/offset options are forwarded to the SDK.
    expect(sessionFnStubs.listSessions.mock.calls[0]?.[0]).toEqual({ dir: '/proj' });
  });

  test('get-session-info returns info, and null when the session is not found', async () => {
    const manager = new SessionManager(makeConfig());
    // Not found (stub default resolves undefined) ⇒ info: null.
    const miss = await manager.handleQuery({
      type: 'get-session-info',
      requestId: 'q2',
      sdkSessionId: 'gone',
    });
    expect(miss).toEqual({
      type: 'query-result',
      requestId: 'q2',
      ok: true,
      kind: 'session-info',
      info: null,
    });

    sessionFnStubs.getSessionInfo.mockImplementationOnce(() =>
      Promise.resolve({ sessionId: 'u', summary: 's', lastModified: 1 }),
    );
    const hit = await manager.handleQuery({
      type: 'get-session-info',
      requestId: 'q3',
      sdkSessionId: 'u',
    });
    expect(hit.info).toEqual({ sdkSessionId: 'u', summary: 's', lastModified: 1 });
  });

  test('get-session-messages maps snake_case SDK keys to the camelCase wire shape', async () => {
    sessionFnStubs.getSessionMessages.mockImplementationOnce(() =>
      Promise.resolve([
        {
          type: 'assistant',
          uuid: 'm1',
          session_id: 'u',
          message: { role: 'assistant', content: 'hi' },
          parent_tool_use_id: null,
        },
      ]),
    );
    const manager = new SessionManager(makeConfig());
    const result = await manager.handleQuery({
      type: 'get-session-messages',
      requestId: 'q4',
      sdkSessionId: 'u',
    });
    expect(result).toEqual({
      type: 'query-result',
      requestId: 'q4',
      ok: true,
      kind: 'messages',
      messages: [
        {
          type: 'assistant',
          uuid: 'm1',
          sessionId: 'u',
          message: { role: 'assistant', content: 'hi' },
          parentToolUseId: null,
        },
      ],
    });
  });

  test('rename-session acks on success and reports failure when the SDK throws', async () => {
    const manager = new SessionManager(makeConfig());
    const ok = await manager.handleQuery({
      type: 'rename-session',
      requestId: 'q5',
      sdkSessionId: 'u',
      title: 'New',
    });
    expect(ok).toEqual({ type: 'query-result', requestId: 'q5', ok: true, kind: 'ack' });

    sessionFnStubs.renameSession.mockImplementationOnce(() =>
      Promise.reject(new Error('locked')),
    );
    const fail = await manager.handleQuery({
      type: 'rename-session',
      requestId: 'q6',
      sdkSessionId: 'u',
      title: 'New',
    });
    expect(fail.ok).toBe(false);
    expect(fail.kind).toBe('ack');
  });

  test('tag-session forwards a null tag to clear it', async () => {
    const manager = new SessionManager(makeConfig());
    const result = await manager.handleQuery({
      type: 'tag-session',
      requestId: 'q7',
      sdkSessionId: 'u',
      tag: null,
    });
    expect(result).toEqual({ type: 'query-result', requestId: 'q7', ok: true, kind: 'ack' });
    expect(sessionFnStubs.tagSession.mock.calls[0]?.slice(0, 2)).toEqual(['u', null]);
  });

  test('get-capabilities answers with the provider descriptor, single-sourced', async () => {
    // Provider-static: the reply is the provider's own truthful capability matrix
    // (issue #18), so the Rust core can single-source it from the engine.
    const manager = new SessionManager(makeConfig());
    const result = await manager.handleQuery({
      type: 'get-capabilities',
      requestId: 'q8',
    });
    expect(result).toEqual({
      type: 'query-result',
      requestId: 'q8',
      ok: true,
      kind: 'capabilities',
      capabilities: CLAUDE_CAPABILITIES,
    });
  });
});

describe('SessionManager issue-validation commands (routed to the scan router)', () => {
  /** Minimal Logger whose `debug` is a spy; `child` returns itself so the
   *  ScanRouter's `logger.child('issue-triage')` shares the same recorder. */
  function makeDebugSpyLogger() {
    const debug = mock(() => {});
    const logger = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug,
      child() {
        return logger;
      },
    };
    return { logger, debug };
  }

  test('cancel-issue-validation is caught by the scan router before the sessionId lookup: safe no-op, no interactive session, not mislogged as an unknown session, never throws', async () => {
    const { logger, debug } = makeDebugSpyLogger();
    const manager = new SessionManager(makeConfig(), logger);

    // Slice 2/5 wired the Issue-triage engine manager into the ScanRouter, so the
    // runId-keyed `*-issue-validation` family is now recognized by `scans.handles()`
    // and delegated to that manager BEFORE the `command.sessionId` lookup (these carry
    // a `runId`, not a `sessionId`). A cancel for a run that isn't active is a safe
    // no-op: it must resolve to undefined and spawn no interactive session. (The full
    // start → verdict flow is covered hermetically in `scans/issue-triage/manager.test.ts`
    // with a fake runner — a real start dispatched at THIS level would spawn an SDK
    // session, which is exactly what the supervisor must not do.)
    await expect(
      manager.dispatch({ type: 'cancel-issue-validation', runId: 'run-iv1' }),
    ).resolves.toBeUndefined();

    // Routed, not dropped: because the scan-router branch swallowed it first, the
    // `command for unknown session dropped` debug (the sessionId-lookup miss path)
    // must NOT have fired for this runId-keyed command.
    const mislogged = debug.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('unknown session'),
    );
    expect(mislogged).toBeUndefined();

    // No interactive session was spawned for the runId-keyed command.
    expect(manager.activeCount).toBe(0);
  });

  test('a genuinely session-keyed command for a missing session DOES reach the sessionId lookup and is dropped — pinning the precedence the cancel case relies on', async () => {
    const { logger, debug } = makeDebugSpyLogger();
    const manager = new SessionManager(makeConfig(), logger);

    // Contrast that keeps the assertion above honest: a `sessionId`-keyed command for
    // a session that does not exist is NOT caught by `scans.handles()`, so it falls
    // through to the lookup and is logged as dropped. This proves the cancel case
    // skipped that branch by being routed early — not because the log simply never fires.
    await expect(
      manager.dispatch({ type: 'interrupt', sessionId: 9999 }),
    ).resolves.toBeUndefined();

    const droppedLog = debug.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('unknown session') &&
        (c[1] as { sessionId?: number })?.sessionId === 9999,
    );
    expect(droppedLog).toBeDefined();
    expect(manager.activeCount).toBe(0);
  });
});

describe('SessionManager stale interactive replies are observable', () => {
  /** Minimal Logger whose `warn` is a spy; `child` returns itself. */
  function makeSpyLogger() {
    // bun's `mock` records every call arg regardless of the fn's own params.
    const warn = mock(() => {});
    const logger = {
      error: () => {},
      warn,
      info: () => {},
      debug: () => {},
      child() {
        return logger;
      },
    };
    return { logger, warn };
  }

  test('warns when an approve-permission targets an unknown/settled requestId', async () => {
    // `hang` keeps the session live so the command reaches a real runner.
    scripts = [{ kind: 'hang', messages: [initMessage()] }];
    const { logger, warn } = makeSpyLogger();
    const manager = new SessionManager(makeConfig(), logger);
    const { done } = collect(manager, (e) => e.type === 'session-ready');

    await manager.dispatch({ type: 'start-session', prompt: 'hi' });
    await done;

    // No such parked request → runner returns false → the drop must be logged.
    await manager.dispatch({
      type: 'approve-permission',
      sessionId: 1,
      requestId: 'never-registered',
      decision: { behavior: 'deny', message: 'no' },
    });

    expect(warn).toHaveBeenCalled();
    const call = warn.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('permission request'),
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ requestId: 'never-registered', sessionId: 1 });
  });

  test('warns when an answer-question targets an unknown/settled requestId', async () => {
    scripts = [{ kind: 'hang', messages: [initMessage()] }];
    const { logger, warn } = makeSpyLogger();
    const manager = new SessionManager(makeConfig(), logger);
    const { done } = collect(manager, (e) => e.type === 'session-ready');

    await manager.dispatch({ type: 'start-session', prompt: 'hi' });
    await done;

    await manager.dispatch({
      type: 'answer-question',
      sessionId: 1,
      requestId: 'stale-q',
      answer: { behavior: 'cancel' },
    });

    const call = warn.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('question request'),
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ requestId: 'stale-q', sessionId: 1 });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed autonomy invariant at the supervisor seam (issue #18)
// ---------------------------------------------------------------------------

describe('SessionManager fail-closed autonomy invariant', () => {
  const STUB_SESSION: AgentSession = {
    permissionMode: 'default',
    run: async () => {},
    streamInput: () => {},
    interrupt: async () => {},
    setModel: async () => {},
    setAutonomy: async () => {},
    approvePermission: () => false,
    answerQuestion: () => false,
    listModels: async () => [],
    probeConfig: async () => {
      throw new Error('probe not used in this test');
    },
  };

  /** A provider whose ONLY material difference from Claude is that it cannot enforce
   *  PreToolUse hooks — it refuses elevated autonomy at the seam exactly as the
   *  invariant demands (never spins a real SDK session). */
  class DegradedProvider implements AgentProvider {
    capabilities() {
      return {
        ...CLAUDE_CAPABILITIES,
        id: 'fake',
        label: 'Fake',
        supportsHooks: false,
      };
    }
    preflight(request: PreflightRequest): void {
      assertHooksInvariant(this.capabilities(), request.autonomy, {
        osSandboxed: request.osSandboxed,
      });
    }
    startSession(params: StartSessionParams): AgentSession {
      const autonomy = params.autonomyOverride ?? 'ask';
      this.preflight({
        autonomy,
        osSandboxed: params.sandboxWrites === true,
      });
      return { ...STUB_SESSION, permissionMode: autonomyToPermissionMode(autonomy) };
    }
    createProbeSession(): AgentSession {
      return STUB_SESSION;
    }
  }

  function isFailed(
    e: NightcoreEvent,
  ): e is Extract<NightcoreEvent, { type: 'session-failed' }> {
    return e.type === 'session-failed';
  }

  test('REFUSES bypass on a no-hooks provider — terminal session-failed, no start', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new DegradedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({
      type: 'start-session',
      prompt: 'x',
      autonomy: 'bypass',
    });

    const failed = events.find(isFailed);
    expect(failed).toBeDefined();
    expect(failed?.message).toContain('hooks');
    expect(events.some((e) => e.type === 'session-started')).toBe(false);
  });

  test('STARTS at a non-elevated autonomy on the same degraded provider', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new DegradedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({
      type: 'start-session',
      prompt: 'x',
      autonomy: 'ask',
    });

    expect(events.some((e) => e.type === 'session-started')).toBe(true);
    expect(events.some(isFailed)).toBe(false);
  });

  test('permits bypass when the OS write sandbox compensates', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new DegradedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({
      type: 'start-session',
      prompt: 'x',
      autonomy: 'bypass',
      sandboxWrites: true,
    });

    expect(events.some((e) => e.type === 'session-started')).toBe(true);
    expect(events.some(isFailed)).toBe(false);
  });
});

describe('SessionManager fail-closed governance invariant (#296)', () => {
  const STUB_SESSION: AgentSession = {
    permissionMode: 'acceptEdits',
    run: async () => {},
    streamInput: () => {},
    interrupt: async () => {},
    setModel: async () => {},
    setAutonomy: async () => {},
    approvePermission: () => false,
    answerQuestion: () => false,
    listModels: async () => [],
    probeConfig: async () => {
      throw new Error('probe not used in this test');
    },
  };

  /** An armed-but-empty Harness policy — presence alone arms the layer. */
  const ARMED_POLICY: HarnessPolicy = {
    protectedPaths: [],
    denyBashPatterns: [],
    denyReadPaths: [],
    disallowedTools: [],
    allowTools: [],
    askTools: [],
    allowExecSinks: [],
  };

  /** A provider whose ONLY material difference from Claude is that it cannot
   *  enforce Harness policy or write a ledger — mirrors `CODEX_CAPABILITIES`'s
   *  shape without hardcoding a real Codex session (never spins one). */
  class UngovernedProvider implements AgentProvider {
    capabilities() {
      return {
        ...CLAUDE_CAPABILITIES,
        id: 'fake-ungoverned',
        label: 'FakeUngoverned',
        supportsHarnessPolicy: false,
        supportsLedger: false,
      };
    }
    preflight(): void {}
    startSession(params: StartSessionParams): AgentSession {
      assertGovernanceInvariant(this.capabilities(), params);
      return STUB_SESSION;
    }
    createProbeSession(): AgentSession {
      return STUB_SESSION;
    }
  }

  function isFailed(
    e: NightcoreEvent,
  ): e is Extract<NightcoreEvent, { type: 'session-failed' }> {
    return e.type === 'session-failed';
  }

  test('REFUSES a run with an armed Harness policy — terminal session-failed, no start', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new UngovernedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({
      type: 'start-session',
      prompt: 'x',
      harnessPolicy: ARMED_POLICY,
    });

    const failed = events.find(isFailed);
    expect(failed).toBeDefined();
    expect(failed?.message).toContain('Harness governance policy');
    expect(events.some((e) => e.type === 'session-started')).toBe(false);
  });

  test('REFUSES a run with a ledger path requested', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new UngovernedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({
      type: 'start-session',
      prompt: 'x',
      ledgerPath: '/tmp/nc-ledger.ndjson',
    });

    const failed = events.find(isFailed);
    expect(failed).toBeDefined();
    expect(failed?.message).toContain('audit ledger');
    expect(events.some((e) => e.type === 'session-started')).toBe(false);
  });

  test('STARTS a run with NO active policy or ledger on the same ungoverned provider', async () => {
    const manager = new SessionManager(
      makeConfig(),
      undefined,
      new UngovernedProvider(),
    );
    const events: NightcoreEvent[] = [];
    manager.on((e) => events.push(e));

    await manager.dispatch({ type: 'start-session', prompt: 'x' });

    expect(events.some((e) => e.type === 'session-started')).toBe(true);
    expect(events.some(isFailed)).toBe(false);
  });
});

describe('SessionManager provider registry routing', () => {
  function provider(id: string, models: string[]): AgentProvider & { started: StartSessionParams[] } {
    const started: StartSessionParams[] = [];
    const session: AgentSession = {
      permissionMode: 'default',
      run: async () => {},
      streamInput: () => {},
      interrupt: async () => {},
      setModel: async () => {},
      setAutonomy: async () => {},
      approvePermission: () => false,
      answerQuestion: () => false,
      listModels: async () =>
        models.map((model) => ({
          providerId: id,
          value: model,
          displayName: model,
          description: `${id} model`,
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        })),
      probeConfig: async () => {
        throw new Error('probe not used in this test');
      },
    };
    return {
      started,
      capabilities: () => ({ ...CLAUDE_CAPABILITIES, id, label: id }),
      preflight: () => {},
      startSession: (params) => {
        started.push(params);
        return session;
      },
      createProbeSession: () => session,
    };
  }

  test('start-session providerId selects the provider per run', async () => {
    const claude = provider('claude', ['claude-opus-4-8']);
    const codex = provider('codex', ['gpt-5-codex']);
    const registry: ProviderRegistry = {
      forSession: (id) => (id === 'codex' ? codex : claude),
      all: () => [claude, codex],
    };
    const manager = new SessionManager(makeConfig(), undefined, registry);

    await manager.dispatch({ type: 'start-session', prompt: 'a' });
    await manager.dispatch({
      type: 'start-session',
      prompt: 'b',
      providerId: 'codex',
      model: 'gpt-5-codex',
    });

    expect(claude.started.map((p) => p.prompt)).toEqual(['a']);
    expect(codex.started.map((p) => p.prompt)).toEqual(['b']);
    expect(codex.started[0]?.model).toBe('gpt-5-codex');
  });

  test('listModels returns a merged catalog across registered providers', async () => {
    const claude = provider('claude', ['claude-opus-4-8']);
    const codex = provider('codex', ['gpt-5-codex']);
    const manager = new SessionManager(makeConfig(), undefined, {
      forSession: (id) => (id === 'codex' ? codex : claude),
      all: () => [claude, codex],
    });

    await expect(manager.listModels()).resolves.toEqual([
      expect.objectContaining({ providerId: 'claude', value: 'claude-opus-4-8' }),
      expect.objectContaining({ providerId: 'codex', value: 'gpt-5-codex' }),
    ]);
  });
});
