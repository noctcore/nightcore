/// <reference types="bun" />
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, test } from 'bun:test';

import type {
  HarnessPolicy,
  NightcoreEvent,
  NightcoreEventOf,
  WireImage,
} from '@nightcore/contracts';

import type { AgentSession } from '../agent-provider.js';
import {
  AutonomyNotPermittedError,
  GovernanceNotSupportedError,
} from '../agent-provider.js';
import { CODEX_CAPABILITIES } from './capabilities.js';
import type { CodexFactory, CodexThreadLike } from './codex-agent-provider.js';
import { CodexAgentProvider } from './codex-agent-provider.js';
import { parseModelList } from './model-catalog.js';
import {
  buildCodexEnv,
  buildCodexOptions,
  buildCodexThreadOptions,
  CODEX_BYPASS_OPT_IN_ENV,
  codexEffectiveAutonomy,
  codexKindForcesReadOnly,
  codexPostureForAutonomy,
  effortToCodexEffort,
} from './options.js';
import {
  createCodexTranslationState,
  type Input,
  type ThreadEvent,
  translateCodexEvent,
} from './sdk-adapter.js';

function collector(): {
  emit: (event: NightcoreEvent) => void;
  events: NightcoreEvent[];
} {
  const events: NightcoreEvent[] = [];
  return { emit: (event) => events.push(event), events };
}

/** An ARMED Harness policy — present AND carrying an actual rule (matches the
 *  spike's Option C scoping: "present AND non-empty"). */
const ARMED_POLICY: HarnessPolicy = {
  protectedPaths: ['bun.lock'],
  denyBashPatterns: [],
  denyReadPaths: [],
  disallowedTools: [],
  allowTools: [],
  askTools: [],
  allowExecSinks: [],
};

const provider = new CodexAgentProvider();

describe('CODEX_CAPABILITIES', () => {
  test('advertises the real Codex matrix', () => {
    expect(CODEX_CAPABILITIES.id).toBe('codex');
    expect(CODEX_CAPABILITIES.label).toBe('Codex');
    // `ask` is NOT advertised: Codex has no approval channel, so an `ask` posture
    // could never be answered and would deadlock — the picker must never offer it.
    expect(CODEX_CAPABILITIES.autonomyLevels).toEqual(['auto-accept', 'plan']);
    expect(CODEX_CAPABILITIES.autonomyLevels).not.toContain('ask');
    expect(CODEX_CAPABILITIES.supportsHooks).toBe(false);
    expect(CODEX_CAPABILITIES.providesOwnWriteContainment).toBe(true);
    expect(CODEX_CAPABILITIES.supportsMcp).toBe(true);
    expect(CODEX_CAPABILITIES.supportsStructuredOutput).toBe(true);
    expect(CODEX_CAPABILITIES.supportsSessionResume).toBe(true);
    expect(CODEX_CAPABILITIES.supportsFileCheckpointing).toBe(false);
    expect(CODEX_CAPABILITIES.supportsAskUserQuestion).toBe(false);
    expect(CODEX_CAPABILITIES.supportsSettingSources).toBe(true);
    expect(CODEX_CAPABILITIES.supportsSessionStore).toBe(true);
    expect(CODEX_CAPABILITIES.supportsEffort).toBe(true);
    expect(CODEX_CAPABILITIES.costTelemetry).toBe('tokens-only');
    expect(provider.capabilities()).toBe(CODEX_CAPABILITIES);
  });
});

describe('Codex autonomy posture', () => {
  test('maps neutral autonomy to Codex sandbox and approval modes', () => {
    expect(codexPostureForAutonomy('plan', { bypassOptedIn: false })).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      contained: true,
    });
    // `ask` degrades to the SAFE read-only floor (never workspace-write): Codex can't
    // prompt, so the "ask first" expectation must not silently become autonomous writes.
    expect(codexPostureForAutonomy('ask', { bypassOptedIn: false })).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      contained: true,
    });
    expect(
      codexPostureForAutonomy('auto-accept', { bypassOptedIn: false }),
    ).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      contained: true,
    });
    expect(codexPostureForAutonomy('bypass', { bypassOptedIn: false })).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      contained: false,
    });
    expect(codexPostureForAutonomy('bypass', { bypassOptedIn: true })).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      contained: false,
    });
  });

  test('NO posture uses an unanswerable approval policy (the deadlock invariant)', () => {
    // The codex-sdk has no approval channel, so `on-request`/`on-failure`/`untrusted`
    // would hang forever. Every posture must resolve to `never` — fail-visible, never
    // a silent hang.
    for (const autonomy of ['plan', 'ask', 'auto-accept', 'bypass'] as const) {
      for (const bypassOptedIn of [false, true]) {
        expect(
          codexPostureForAutonomy(autonomy, { bypassOptedIn }).approvalPolicy,
        ).toBe('never');
      }
    }
  });

  test('auto-accept is permitted because Codex supplies native containment', () => {
    expect(() =>
      provider.preflight({ autonomy: 'auto-accept', osSandboxed: true }),
    ).not.toThrow();
  });

  test('bypass is refused without explicit opt-in', () => {
    expect(() =>
      provider.preflight({ autonomy: 'bypass', osSandboxed: false }),
    ).toThrow(AutonomyNotPermittedError);
  });

  test('startSession refuses bypass before constructing a session', () => {
    const { emit, events } = collector();
    expect(() =>
      provider.startSession(
        {
          sessionId: 1,
          prompt: 'go',
          model: 'gpt-5-codex',
          cwd: '/tmp',
          autonomyOverride: 'bypass',
        },
        emit,
      ),
    ).toThrow(AutonomyNotPermittedError);
    expect(events).toHaveLength(0);
  });

  test('bypass can be explicitly opted in at process level', () => {
    const previous = process.env[CODEX_BYPASS_OPT_IN_ENV];
    process.env[CODEX_BYPASS_OPT_IN_ENV] = '1';
    try {
      const { emit } = collector();
      const session = provider.startSession(
        {
          sessionId: 2,
          prompt: 'go',
          model: 'gpt-5-codex',
          cwd: '/tmp',
          autonomyOverride: 'bypass',
        },
        emit,
      );
      expect(session.permissionMode).toBe('bypassPermissions');
    } finally {
      if (previous === undefined) {
        delete process.env[CODEX_BYPASS_OPT_IN_ENV];
      } else {
        process.env[CODEX_BYPASS_OPT_IN_ENV] = previous;
      }
    }
  });
});

describe('Codex governance preflight (#296)', () => {
  test('startSession refuses a run with an ARMED Harness policy before constructing a session', () => {
    const { emit, events } = collector();
    expect(() =>
      provider.startSession(
        {
          sessionId: 10,
          prompt: 'go',
          model: 'gpt-5-codex',
          cwd: '/tmp',
          autonomyOverride: 'auto-accept',
          harnessPolicy: ARMED_POLICY,
        },
        emit,
      ),
    ).toThrow(GovernanceNotSupportedError);
    expect(events).toHaveLength(0);
  });

  test('startSession PROCEEDS with the real production params shape: an always-on ledger path but NO armed policy (#296 regression)', () => {
    // THE bug this pins: the Rust core sets `ledgerPath` UNCONDITIONALLY for every
    // project-scoped run (`build_guardrails` in `sidecar/commands.rs` — see
    // `assertGovernanceInvariant`'s docblock), regardless of whether a Harness
    // policy is armed. Every real Codex task launched inside a project carries
    // exactly this shape. Treating `ledgerPath` presence as "governance requested"
    // would refuse EVERY such run — silently disabling the Codex provider
    // entirely. This must proceed.
    const { emit } = collector();
    const session = provider.startSession(
      {
        sessionId: 11,
        prompt: 'go',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        autonomyOverride: 'auto-accept',
        // No `harnessPolicy` — the project has no `.nightcore/harness.json` armed —
        // but `ledgerPath` is set exactly as `build_guardrails` always sets it.
        ledgerPath: '/proj/.nightcore/ledger/task-1.ndjson',
      },
      emit,
    );
    expect(session).toBeDefined();
  });

  test('startSession PROCEEDS on a present-but-EMPTY Harness policy (self-protection-only manifest)', () => {
    const { emit } = collector();
    const session = provider.startSession(
      {
        sessionId: 12,
        prompt: 'go',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        autonomyOverride: 'auto-accept',
        harnessPolicy: {
          protectedPaths: [],
          denyBashPatterns: [],
          denyReadPaths: [],
          disallowedTools: [],
          allowTools: [],
          askTools: [],
          allowExecSinks: [],
        },
      },
      emit,
    );
    expect(session).toBeDefined();
  });

  test('startSession proceeds when NO harness policy or ledger is requested', () => {
    const { emit } = collector();
    const session = provider.startSession(
      {
        sessionId: 13,
        prompt: 'go',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        autonomyOverride: 'auto-accept',
      },
      emit,
    );
    expect(session).toBeDefined();
  });

  test('the refusal names Codex', () => {
    let caught: unknown;
    try {
      provider.startSession(
        {
          sessionId: 14,
          prompt: 'go',
          model: 'gpt-5-codex',
          cwd: '/tmp',
          autonomyOverride: 'auto-accept',
          harnessPolicy: ARMED_POLICY,
          ledgerPath: '/proj/.nightcore/ledger/task-1.ndjson',
        },
        () => {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GovernanceNotSupportedError);
    const err = caught as GovernanceNotSupportedError;
    expect(err.providerId).toBe('codex');
    expect(err.message).toContain('codex');
    expect(err.message).toContain('Harness governance policy');
  });
});

describe('Codex reviewer read-only posture', () => {
  test('the review and decompose kinds are pinned read-only', () => {
    expect(codexKindForcesReadOnly('review')).toBe(true);
    // Decompose investigates read-only and only PROPOSES sub-tasks, so it must never
    // mutate the repo — mirror Claude's `WRITE_TOOLS` denial by pinning it to the
    // read-only sandbox (issue #296 item 3).
    expect(codexKindForcesReadOnly('decompose')).toBe(true);
    expect(codexKindForcesReadOnly('build')).toBe(false);
    expect(codexKindForcesReadOnly('tdd')).toBe(false);
    expect(codexKindForcesReadOnly('research')).toBe(false);
    expect(codexKindForcesReadOnly(undefined)).toBe(false);
  });

  test('a review or decompose run is forced to plan regardless of the resolved autonomy', () => {
    // Even an elevated writable ceiling collapses to read-only `plan` for a reviewer.
    expect(codexEffectiveAutonomy('auto-accept', 'review')).toBe('plan');
    expect(codexEffectiveAutonomy('bypass', 'review')).toBe('plan');
    expect(codexEffectiveAutonomy(undefined, 'review')).toBe('plan');
    // A writable autonomy is forced read-only for decompose too (the read-only proposer).
    expect(codexEffectiveAutonomy('auto-accept', 'decompose')).toBe('plan');
    expect(codexEffectiveAutonomy('bypass', 'decompose')).toBe('plan');
    expect(codexEffectiveAutonomy(undefined, 'decompose')).toBe('plan');
    // Write-capable kinds pass the requested autonomy through (undefined → safe plan).
    expect(codexEffectiveAutonomy('auto-accept', 'build')).toBe('auto-accept');
    expect(codexEffectiveAutonomy(undefined, 'build')).toBe('plan');
  });

  test('the reviewer posture is provably read-only at the SDK boundary', () => {
    // The concrete guarantee handed to `codex exec`: read-only sandbox, no approval
    // escalation. A write is denied by the kernel, not merely by a tool denylist.
    const threadOptions = buildCodexThreadOptions({
      model: 'gpt-5-codex',
      cwd: '/repo',
      posture: codexPostureForAutonomy(
        codexEffectiveAutonomy('auto-accept', 'review'),
        { bypassOptedIn: true },
      ),
    });
    expect(threadOptions.sandboxMode).toBe('read-only');
    expect(threadOptions.approvalPolicy).toBe('never');
  });

  test('startSession records a review run as read-only even when handed auto-accept', () => {
    const { emit } = collector();
    const session = provider.startSession(
      {
        sessionId: 42,
        prompt: 'review this',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        kind: 'review',
        autonomyOverride: 'auto-accept',
      },
      emit,
    );
    // `plan` is the read-only record mode: the reviewer never gets a writable session.
    expect(session.permissionMode).toBe('plan');
  });

  test('startSession records a decompose run as read-only even when handed auto-accept', () => {
    const { emit } = collector();
    const session = provider.startSession(
      {
        sessionId: 44,
        prompt: 'decompose this goal',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        kind: 'decompose',
        autonomyOverride: 'auto-accept',
      },
      emit,
    );
    // Decompose is a read-only proposer: it never gets a writable session, mirroring
    // Claude's `WRITE_TOOLS` denial for the decompose preset.
    expect(session.permissionMode).toBe('plan');
  });

  test('a review run under bypass is pinned read-only, not refused', () => {
    // A reviewer dispatched while the global default is `bypass` must NOT be refused
    // (it is read-only anyway) and must NOT be handed danger-full-access.
    const previous = process.env[CODEX_BYPASS_OPT_IN_ENV];
    process.env[CODEX_BYPASS_OPT_IN_ENV] = '1';
    try {
      const { emit } = collector();
      const session = provider.startSession(
        {
          sessionId: 43,
          prompt: 'review this',
          model: 'gpt-5-codex',
          cwd: '/tmp',
          kind: 'review',
          autonomyOverride: 'bypass',
        },
        emit,
      );
      expect(session.permissionMode).toBe('plan');
    } finally {
      if (previous === undefined) delete process.env[CODEX_BYPASS_OPT_IN_ENV];
      else process.env[CODEX_BYPASS_OPT_IN_ENV] = previous;
    }
  });
});

describe('Codex option mapping', () => {
  test('curates env and maps CODEX_API_KEY only', () => {
    expect(
      buildCodexEnv({
        PATH: '/bin',
        HOME: '/home/me',
        SHELL: '/bin/zsh',
        CODEX_API_KEY: 'codex-key',
        OPENAI_API_KEY: 'openai-key',
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/me',
      SHELL: '/bin/zsh',
      CODEX_API_KEY: 'codex-key',
    });
  });

  test('threads binary override and MCP config through CodexOptions', () => {
    const options = buildCodexOptions({
      codexPathOverride: '/usr/local/bin/codex',
      env: { PATH: '/bin' },
      mcpServers: [
        {
          id: '1',
          name: 'local',
          enabled: true,
          config: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: {},
          },
        },
      ],
    });
    expect(options.codexPathOverride).toBe('/usr/local/bin/codex');
    expect(options.env).toEqual({ PATH: '/bin' });
    expect(options.config).toEqual({
      mcp_servers: { local: { command: 'node', args: ['server.js'] } },
    });
  });

  test('maps Nightcore max effort to Codex xhigh', () => {
    expect(effortToCodexEffort(undefined)).toBeUndefined();
    expect(effortToCodexEffort('high')).toBe('high');
    expect(effortToCodexEffort('max')).toBe('xhigh');
  });

  test('builds thread options with sandbox and git check policy', () => {
    const options = buildCodexThreadOptions({
      model: 'gpt-5-codex',
      effort: 'medium',
      cwd: '/repo',
      posture: codexPostureForAutonomy('auto-accept', { bypassOptedIn: false }),
    });
    expect(options).toEqual({
      model: 'gpt-5-codex',
      workingDirectory: '/repo',
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      modelReasoningEffort: 'medium',
    });
  });
});

describe('Codex app-server model catalog', () => {
  test('maps model/list responses to provider-stamped descriptors', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'model-id',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            description: 'Frontier model.',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'xhigh', description: 'Deep' },
              { reasoningEffort: 'minimal', description: 'Codex-only effort' },
            ],
          },
          {
            id: 'hidden',
            model: 'hidden-model',
            displayName: 'Hidden',
            description: 'Not shown.',
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      }),
    ).toEqual([
      {
        providerId: 'codex',
        value: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Frontier model.',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'xhigh'],
      },
    ]);
  });
});

describe('CodexSession run contract', () => {
  test('invalid explicit binary override emits a terminal failure and resolves', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    process.env.NIGHTCORE_AGENT_PATH = '/definitely/missing/nightcore-codex';
    delete process.env.NIGHTCORE_CODEX_PATH;
    try {
      const { emit, events } = collector();
      const session = provider.startSession(
        {
          sessionId: 99,
          prompt: 'go',
          model: 'gpt-5-codex',
          cwd: '/tmp',
        },
        emit,
      );

      await expect(session.run()).resolves.toBeUndefined();
      expect(events).toEqual([
        {
          type: 'session-failed',
          sessionId: 99,
          reason: 'runner-crash',
          message:
            'Codex binary override does not exist: /definitely/missing/nightcore-codex',
        },
      ]);
    } finally {
      if (previousAgentPath === undefined) {
        delete process.env.NIGHTCORE_AGENT_PATH;
      } else {
        process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      }
      if (previousCodexPath === undefined) {
        delete process.env.NIGHTCORE_CODEX_PATH;
      } else {
        process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
      }
    }
  });

  test('reaps a wedged turn via the idle watchdog (fail-visible, never a silent hang)', async () => {
    // A thread that streams the opening events then WEDGES — never yielding a
    // terminal `turn.completed`/`turn.failed`. Without the Rust-side/engine idle
    // watchdog this would hang the run forever and leak its concurrency slot.
    const stallingThread: CodexThreadLike = {
      runStreamed() {
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: 'thread.started', thread_id: 'thread-stall' };
          yield { type: 'turn.started' };
          // Wedge: park forever with no further (and no terminal) event.
          await new Promise<void>(() => {});
        }
        return Promise.resolve({ events: events() });
      },
    };
    const factory: CodexFactory = () => ({
      startThread: () => stallingThread,
      resumeThread: () => stallingThread,
    });
    // 20ms idle deadline so the watchdog trips at once instead of after 30 minutes.
    const provider = new CodexAgentProvider(undefined, factory, 20);
    const { emit, events } = collector();
    const session = provider.startSession(
      {
        sessionId: 77,
        prompt: 'go',
        model: 'gpt-5-codex',
        cwd: '/tmp',
        autonomyOverride: 'auto-accept',
      },
      emit,
    );

    // The stall path degrades-not-throws: run() resolves with a terminal failure.
    await expect(session.run()).resolves.toBeUndefined();
    // A session-ready was emitted before the stall (from thread.started).
    expect(events.some((e) => e.type === 'session-ready')).toBe(true);
    const failure = events.find((e) => e.type === 'session-failed') as
      | NightcoreEventOf<'session-failed'>
      | undefined;
    expect(failure).toMatchObject({ sessionId: 77, reason: 'runner-crash' });
    expect(failure?.message).toContain('stalled');
  });
});

describe('Codex follow-up turns (streamInput)', () => {
  /** A fake thread whose runStreamed streams one normal turn; turn 1 fires `onTurnOne`
   *  just before completing (to simulate a mid-run follow-up) and records each input. */
  function scriptedThread(
    inputs: string[],
    onTurnOne?: () => void,
  ): CodexThreadLike {
    return {
      runStreamed(input) {
        inputs.push(typeof input === 'string' ? input : JSON.stringify(input));
        const turnIndex = inputs.length;
        async function* events(): AsyncGenerator<ThreadEvent> {
          if (turnIndex === 1) {
            yield { type: 'thread.started', thread_id: 'thread-1' };
          }
          yield { type: 'turn.started' };
          yield {
            type: 'item.completed',
            item: {
              id: `msg-${turnIndex}`,
              type: 'agent_message',
              text: `turn ${turnIndex}`,
            },
          };
          if (turnIndex === 1) onTurnOne?.();
          yield {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          };
        }
        return Promise.resolve({ events: events() });
      },
    };
  }

  function fakeProvider(
    inputs: string[],
    onTurnOne?: () => void,
  ): CodexAgentProvider {
    const factory: CodexFactory = () => {
      // One thread per session; its runStreamed is called once per turn (the SDK
      // resumes the thread by id on subsequent calls).
      const thread = scriptedThread(inputs, onTurnOne);
      return { startThread: () => thread, resumeThread: () => thread };
    };
    return new CodexAgentProvider(undefined, factory);
  }

  const runParams = (sessionId: number) =>
    ({
      sessionId,
      prompt: 'do the thing',
      model: 'gpt-5-codex',
      cwd: '/tmp',
      kind: 'research' as const,
      autonomyOverride: 'auto-accept' as const,
    });

  test('delivers a mid-run message as a follow-up turn (never dropped)', async () => {
    const inputs: string[] = [];
    const completed: NightcoreEvent[] = [];
    // Holder so the mid-turn hook can reach the session that owns the factory.
    const ref: { session?: AgentSession } = {};
    const provider = fakeProvider(inputs, () => {
      // A follow-up arrives WHILE turn 1 is still streaming.
      ref.session?.streamInput('please also add a test');
    });
    ref.session = provider.startSession(runParams(5), (event) => {
      if (event.type === 'session-completed') completed.push(event);
    });
    await ref.session.run();

    // The follow-up was delivered as a SECOND turn (resume), not silently dropped.
    expect(inputs).toEqual(['do the thing', 'please also add a test']);
    // Only the FINAL turn finalizes the session — no premature session-completed.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ numTurns: 2 });
  });

  test('a run with no follow-up completes in a single turn', async () => {
    const inputs: string[] = [];
    const completed: NightcoreEvent[] = [];
    const provider = fakeProvider(inputs);
    const session = provider.startSession(runParams(6), (event) => {
      if (event.type === 'session-completed') completed.push(event);
    });
    await session.run();

    expect(inputs).toEqual(['do the thing']);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ numTurns: 1 });
  });

  test('empty follow-up input is ignored', async () => {
    const inputs: string[] = [];
    const ref: { session?: AgentSession } = {};
    const provider = fakeProvider(inputs, () => ref.session?.streamInput(''));
    ref.session = provider.startSession(runParams(7), () => {});
    await ref.session.run();

    expect(inputs).toEqual(['do the thing']);
  });
});

describe('Codex image attachments (local_image)', () => {
  const tinyImage = (tag: string): WireImage => ({
    format: 'png',
    data: Buffer.from(`image-bytes-${tag}`).toString('base64'),
  });

  /** A thread that records each turn's raw `Input` and, for image turns, whether each
   *  `local_image` path existed AT CALL TIME (i.e. while the turn ran, before run()'s
   *  cleanup `finally` fires). Fires `onTurnOne` just before completing turn 1 so a
   *  test can inject a mid-run follow-up. */
  function recordingThread(
    received: Input[],
    existedDuringTurn: boolean[],
    onTurnOne?: () => void,
  ): CodexThreadLike {
    return {
      runStreamed(input) {
        received.push(input);
        if (Array.isArray(input)) {
          for (const part of input) {
            if (part.type === 'local_image') {
              existedDuringTurn.push(existsSync(part.path));
            }
          }
        }
        const turnIndex = received.length;
        async function* events(): AsyncGenerator<ThreadEvent> {
          if (turnIndex === 1) {
            yield { type: 'thread.started', thread_id: 'thread-img' };
          }
          yield { type: 'turn.started' };
          yield {
            type: 'item.completed',
            item: {
              id: `msg-${turnIndex}`,
              type: 'agent_message',
              text: `turn ${turnIndex}`,
            },
          };
          if (turnIndex === 1) onTurnOne?.();
          yield {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          };
        }
        return Promise.resolve({ events: events() });
      },
    };
  }

  function imageProvider(
    received: Input[],
    existedDuringTurn: boolean[],
    onTurnOne?: () => void,
  ): CodexAgentProvider {
    const factory: CodexFactory = () => {
      // One thread per session; the SDK resumes it by id on each follow-up turn.
      const thread = recordingThread(received, existedDuringTurn, onTurnOne);
      return { startThread: () => thread, resumeThread: () => thread };
    };
    return new CodexAgentProvider(undefined, factory);
  }

  /** The `local_image` paths carried on a turn's input (empty for a plain-string turn). */
  function imagePaths(input: Input | undefined): string[] {
    if (input === undefined || !Array.isArray(input)) return [];
    return input.flatMap((part) => (part.type === 'local_image' ? [part.path] : []));
  }

  // `research` inherits an empty preset (no appended persona), so the first-turn text
  // equals the raw prompt — letting these tests assert the text element exactly.
  const imageParams = (sessionId: number, images?: WireImage[]) =>
    ({
      sessionId,
      prompt: 'describe these',
      model: 'gpt-5-codex',
      cwd: '/tmp',
      kind: 'research' as const,
      autonomyOverride: 'auto-accept' as const,
      ...(images !== undefined ? { images } : {}),
    });

  test('first turn carries the text plus one local_image per image at real, existing, absolute paths', async () => {
    const received: Input[] = [];
    const existed: boolean[] = [];
    const provider = imageProvider(received, existed);
    const { emit } = collector();
    const session = provider.startSession(
      imageParams(50, [tinyImage('a'), tinyImage('b')]),
      emit,
    );
    await session.run();

    expect(received).toHaveLength(1);
    const first = received[0];
    expect(Array.isArray(first)).toBe(true);
    const parts = first as Exclude<Input, string>;
    expect(parts[0]).toEqual({ type: 'text', text: 'describe these' });
    const images = parts.slice(1);
    expect(images).toHaveLength(2);
    for (const part of images) {
      expect(part.type).toBe('local_image');
      if (part.type === 'local_image') {
        expect(isAbsolute(part.path)).toBe(true);
      }
    }
    // Each temp file existed WHILE the turn ran (before the cleanup finally).
    expect(existed).toEqual([true, true]);
  });

  test('a run with no images passes a plain string input (byte-identical to pre-image)', async () => {
    const received: Input[] = [];
    const existed: boolean[] = [];
    const provider = imageProvider(received, existed);
    const { emit } = collector();
    const session = provider.startSession(imageParams(51), emit);
    await session.run();

    expect(received).toEqual(['describe these']);
    expect(existed).toEqual([]);
  });

  test('follow-up turns never carry images (only the first turn does)', async () => {
    const received: Input[] = [];
    const existed: boolean[] = [];
    const ref: { session?: AgentSession } = {};
    const provider = imageProvider(received, existed, () => {
      ref.session?.streamInput('and now a follow-up');
    });
    const { emit } = collector();
    ref.session = provider.startSession(imageParams(52, [tinyImage('a')]), emit);
    await ref.session.run();

    expect(received).toHaveLength(2);
    // Turn 1 carries the image UserInput[]; the follow-up turn is a plain string.
    expect(Array.isArray(received[0])).toBe(true);
    expect(received[1]).toBe('and now a follow-up');
  });

  test('temp image files are cleaned up after the run resolves', async () => {
    const received: Input[] = [];
    const existed: boolean[] = [];
    const provider = imageProvider(received, existed);
    const { emit } = collector();
    const session = provider.startSession(
      imageParams(53, [tinyImage('a'), tinyImage('b')]),
      emit,
    );
    await session.run();

    const paths = imagePaths(received[0]);
    expect(paths).toHaveLength(2);
    // Existed during the turn, gone once run() resolved (removed in the finally).
    expect(existed).toEqual([true, true]);
    for (const path of paths) {
      expect(existsSync(path)).toBe(false);
    }
  });
});

describe('Codex probeConfig prerequisite validation', () => {
  const swapEnv = (codexPath: string | undefined) => {
    const prevAgent = process.env.NIGHTCORE_AGENT_PATH;
    const prevCodex = process.env.NIGHTCORE_CODEX_PATH;
    delete process.env.NIGHTCORE_AGENT_PATH;
    if (codexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
    else process.env.NIGHTCORE_CODEX_PATH = codexPath;
    return () => {
      if (prevAgent === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = prevAgent;
      if (prevCodex === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = prevCodex;
    };
  };

  test('surfaces an unavailable snapshot when the codex binary is missing', async () => {
    const restore = swapEnv('/definitely/missing/nightcore-codex-probe');
    try {
      const snapshot = await provider.createProbeSession().probeConfig('/proj');
      expect(snapshot.providerId).toBe('codex');
      expect(snapshot.mcp.status).toBe('unavailable');
      expect(snapshot.skills.status).toBe('unavailable');
      expect(snapshot.extrasStatus).toBe('unavailable');
      // The actionable message reaches the inspector (rendered with a Retry).
      expect(snapshot.mcp.error).toContain(
        '/definitely/missing/nightcore-codex-probe',
      );
    } finally {
      restore();
    }
  });

  test('reports supported sections when a codex binary resolves', async () => {
    // Point the override at a real, existing executable so the existence check passes
    // without spawning anything (probeCodexCli is pure fs/PATH lookups).
    const restore = swapEnv(process.execPath);
    try {
      const snapshot = await provider.createProbeSession().probeConfig('/proj');
      expect(snapshot.mcp.status).toBe('supported');
      expect(snapshot.skills.status).toBe('supported');
      expect(snapshot.extrasStatus).toBe('supported');
      expect(snapshot.subagents.status).toBe('unsupported');
    } finally {
      restore();
    }
  });
});

describe('translateCodexEvent', () => {
  test('translates thread start into session-ready', () => {
    const state = createCodexTranslationState({
      sessionId: 7,
      model: 'gpt-5-codex',
    });
    expect(
      translateCodexEvent({ type: 'thread.started', thread_id: 'thread-1' }, state)
        .events,
    ).toEqual([
      {
        type: 'session-ready',
        sessionId: 7,
        sdkSessionId: 'thread-1',
        model: 'gpt-5-codex',
        tools: [],
        slashCommands: [],
        skills: [],
      },
    ]);
  });

  test('pairs command item start and completion into tool events', () => {
    const state = createCodexTranslationState({
      sessionId: 7,
      model: 'gpt-5-codex',
    });
    const started: ThreadEvent = {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '',
        status: 'in_progress',
      },
    };
    const completed: ThreadEvent = {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: 'ok',
        exit_code: 0,
        status: 'completed',
      },
    };
    expect(translateCodexEvent(started, state).events[0]).toMatchObject({
      type: 'tool-use-requested',
      toolUseId: 'cmd-1',
      toolName: 'command_execution',
      input: { command: 'bun test' },
    });
    expect(translateCodexEvent(completed, state).events[0]).toMatchObject({
      type: 'tool-result',
      toolUseId: 'cmd-1',
      isError: false,
      content: 'ok',
    });
  });

  test('emits token-only session-completed without costUsd', () => {
    const state = createCodexTranslationState({
      sessionId: 7,
      model: 'gpt-5-codex',
      startedAt: Date.now(),
    });
    translateCodexEvent({ type: 'turn.started' }, state);
    translateCodexEvent(
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'done' },
      },
      state,
    );
    const result = translateCodexEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 3,
        },
      },
      state,
    );
    expect(result.terminal).toBe(true);
    expect(result.events[0]).toMatchObject({
      type: 'session-completed',
      sessionId: 7,
      result: 'done',
      numTurns: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 3,
      },
    });
    expect(result.events[0]).not.toHaveProperty('costUsd');
  });
});
