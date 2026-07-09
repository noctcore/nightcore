/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent } from '@nightcore/contracts';

import { AutonomyNotPermittedError } from '../agent-provider.js';
import { CODEX_CAPABILITIES } from './capabilities.js';
import { CodexAgentProvider } from './codex-agent-provider.js';
import { parseModelList } from './model-catalog.js';
import {
  buildCodexEnv,
  buildCodexOptions,
  buildCodexThreadOptions,
  CODEX_BYPASS_OPT_IN_ENV,
  codexPostureForAutonomy,
  effortToCodexEffort,
} from './options.js';
import {
  createCodexTranslationState,
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

const provider = new CodexAgentProvider();

describe('CODEX_CAPABILITIES', () => {
  test('advertises the real Codex matrix', () => {
    expect(CODEX_CAPABILITIES.id).toBe('codex');
    expect(CODEX_CAPABILITIES.label).toBe('Codex');
    expect(CODEX_CAPABILITIES.autonomyLevels).toEqual([
      'auto-accept',
      'ask',
      'plan',
    ]);
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
      approvalPolicy: 'on-request',
      contained: true,
    });
    expect(codexPostureForAutonomy('ask', { bypassOptedIn: false })).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
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
      posture: codexPostureForAutonomy('ask', { bypassOptedIn: false }),
    });
    expect(options).toEqual({
      model: 'gpt-5-codex',
      workingDirectory: '/repo',
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
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
