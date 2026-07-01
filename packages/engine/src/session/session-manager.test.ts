/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, NightcoreEvent } from '@nightcore/contracts';

/**
 * The SDK boundary is stubbed so no live Claude model is ever spawned. Each
 * fake `query()` call pulls the next scripted message script from `nextScript`,
 * exposing a controllable async-iterable plus the control methods the runner
 * proxies to (`interrupt`/`setModel`/`setPermissionMode`).
 */
type Script =
  | { kind: 'messages'; messages: unknown[] }
  | { kind: 'throw'; error: unknown };

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
    // The build preset adds no PERSONA and no tool restriction. permissionMode
    // falls back to the session default. `appendSystemPrompt` still carries the
    // always-present working-root directive (worktree isolation) and nothing else.
    expect(options.appendSystemPrompt).toContain('Working directory (authoritative)');
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
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
      permissionMode: 'plan',
    });
    await done;

    // The review preset defaults to `dontAsk`, but an explicit command mode wins.
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
});
