/// <reference types="bun" />
import { afterAll, describe, expect, mock, test } from 'bun:test';

import type {
  PermissionMode,
  PermissionPolicy,
  SettingSource,
} from '@nightcore/contracts';

/**
 * `SessionOptionsBuilder.base()` calls `resolveClaudeBinary()`; stub it so these
 * tests assert the option composition without depending on a `claude` being
 * installed on the test machine.
 *
 * bun's `mock.module` is a permanent, process-global override; capture the real
 * module first and re-register it in afterAll so this partial stub can't leak
 * into `resolve-claude-binary.test.ts` (which asserts the real memoization).
 */
const realResolveClaudeBinary = { ...(await import('./resolve-claude-binary.js')) };
afterAll(() => {
  mock.module('./resolve-claude-binary.js', () => realResolveClaudeBinary);
});
let resolvedClaudePath: string | undefined;
mock.module('./resolve-claude-binary.js', () => ({
  resolveClaudeBinary: () => resolvedClaudePath,
}));

// Imported AFTER the mock is registered so the builder picks up the stub.
const { SessionOptionsBuilder } = await import('./session-options.js');
const { ASK_USER_QUESTION_DIALOG } = await import('./question-layer.js');
type SessionRunnerConfig = import('./session-options.js').SessionRunnerConfig;
type SessionRunOptionsRuntime =
  import('./session-options.js').SessionRunOptionsRuntime;

const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };
const settingSources: SettingSource[] = [];

function makeConfig(
  overrides: Partial<SessionRunnerConfig> = {},
): SessionRunnerConfig {
  return {
    sessionId: 1,
    prompt: 'hi',
    model: 'claude-opus-4-8',
    permissionMode: 'default' as PermissionMode,
    permissionPolicy: policy,
    cwd: '/repo',
    apiKeyFallback: false,
    settingSources,
    todoFeatureEnabled: false,
    ...overrides,
  };
}

/** Minimal runtime collaborators — the optional layer fields stay `undefined`; the
 *  abort controller is a real instance so identity pass-through can be asserted. */
function makeRuntime(abort = new AbortController()): SessionRunOptionsRuntime {
  return {
    canUseTool: undefined,
    onUserDialog: undefined,
    supportedDialogKinds: [ASK_USER_QUESTION_DIALOG],
    hooks: undefined,
    abortController: abort,
  };
}

describe('SessionOptionsBuilder.base() — shared run + probe options', () => {
  test('sets the core shape and never registers built-in subagent presets', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const base = new SessionOptionsBuilder(makeConfig({ cwd: '/work' })).base();

    expect(base.cwd).toBe('/work');
    expect(base.executable).toBe('bun');
    // Regression: an `agents` key would expose the Task tool to the main model.
    expect(base).not.toHaveProperty('agents');
    // The resolved CLI path is pinned for the `bun --compile` distributable.
    expect(base.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
  });

  test('omits pathToClaudeCodeExecutable when nothing resolves on disk', () => {
    resolvedClaudePath = undefined;
    const base = new SessionOptionsBuilder(makeConfig()).base();
    expect(base).not.toHaveProperty('pathToClaudeCodeExecutable');
  });

  test('applies the tasks toggle to the curated env without wholesale process.env', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const enabled = new SessionOptionsBuilder(
      makeConfig({ todoFeatureEnabled: true }),
    ).base();
    const disabled = new SessionOptionsBuilder(
      makeConfig({ todoFeatureEnabled: false }),
    ).base();

    const enabledEnv = enabled.env as Record<string, string>;
    const disabledEnv = disabled.env as Record<string, string>;
    expect(enabledEnv.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
    expect(disabledEnv.CLAUDE_CODE_ENABLE_TASKS).toBe('0');
    // PATH (a runtime essential) survives the allowlist copy.
    expect(enabledEnv.PATH).toBe(process.env.PATH);
    // AI progress summaries ride the tasks toggle.
    expect(enabled).toHaveProperty('agentProgressSummaries', true);
    expect(disabled).not.toHaveProperty('agentProgressSummaries');
  });

  test('enables the skills filter only when a setting source is loaded', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const isolated = new SessionOptionsBuilder(
      makeConfig({ settingSources: [] }),
    ).base();
    const withSources = new SessionOptionsBuilder(
      makeConfig({ settingSources: ['user'] as SettingSource[] }),
    ).base();

    expect(isolated).not.toHaveProperty('skills');
    expect(withSources).toHaveProperty('skills', 'all');
  });

  test('folds enabled external MCP servers in by name; omits the key when none', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const withMcp = new SessionOptionsBuilder(
      makeConfig({
        mcpServers: [
          {
            id: 'a',
            name: 'alpha',
            enabled: true,
            config: { transport: 'stdio', command: 'npx', args: [], env: {} },
          },
        ],
      }),
    ).base();
    const none = new SessionOptionsBuilder(makeConfig()).base();

    expect(withMcp.mcpServers).toEqual({ alpha: { command: 'npx', args: [] } });
    expect(none).not.toHaveProperty('mcpServers');
  });
});

describe('SessionOptionsBuilder.run() — full query options', () => {
  test('layers per-run knobs and passes the runtime collaborators through', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const abort = new AbortController();
    const options = new SessionOptionsBuilder(
      makeConfig({ model: 'claude-sonnet-4-5' }),
    ).run(makeRuntime(abort));

    expect(options.model).toBe('claude-sonnet-4-5');
    expect(options.permissionMode).toBe('default');
    expect(options.includePartialMessages).toBe(true);
    expect(options.abortController).toBe(abort);
    expect(options.supportedDialogKinds).toEqual([ASK_USER_QUESTION_DIALOG]);
    // Inherits the shared base shape.
    expect(options.executable).toBe('bun');
  });

  test('sets allowDangerouslySkipPermissions only under bypassPermissions', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const bypass = new SessionOptionsBuilder(
      makeConfig({
        permissionMode: 'bypassPermissions' as PermissionMode,
        permissionPolicy: { allow: [], deny: [], mode: 'bypassPermissions' },
      }),
    ).run(makeRuntime());
    const normal = new SessionOptionsBuilder(makeConfig()).run(makeRuntime());

    expect(bypass).toHaveProperty('allowDangerouslySkipPermissions', true);
    expect(normal).not.toHaveProperty('allowDangerouslySkipPermissions');
  });

  test('unions the policy deny list into disallowedTools without duplicates', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({
        permissionMode: 'bypassPermissions' as PermissionMode,
        permissionPolicy: {
          allow: [],
          deny: ['Bash', 'Edit'],
          mode: 'bypassPermissions',
        },
        disallowedTools: ['Bash', 'Write'],
      }),
    ).run(makeRuntime());

    expect((options.disallowedTools as string[]).sort()).toEqual([
      'Bash',
      'Edit',
      'Write',
    ]);
  });

  test('omits disallowedTools when both the preset and deny list are empty', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(makeConfig()).run(makeRuntime());
    expect(options).not.toHaveProperty('disallowedTools');
  });

  test('unions the harness policy allowTools into allowedTools without duplicates', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({
        allowedTools: ['Read', 'WebSearch'],
        harnessPolicy: {
          protectedPaths: [],
          denyBashPatterns: [],
          denyReadPaths: [],
          disallowedTools: [],
          allowTools: ['WebSearch', 'Bash(git status:*)'],
          askTools: [],
        },
      }),
    ).run(makeRuntime());

    expect((options.allowedTools as string[]).sort()).toEqual([
      'Bash(git status:*)',
      'Read',
      'WebSearch',
    ]);
  });

  test('policy allowTools alone sets allowedTools (additive auto-approval, no preset)', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({
        harnessPolicy: {
          protectedPaths: [],
          denyBashPatterns: [],
          denyReadPaths: [],
          disallowedTools: [],
          allowTools: ['WebSearch'],
          askTools: [],
        },
      }),
    ).run(makeRuntime());
    expect(options.allowedTools).toEqual(['WebSearch']);
  });

  test('omits allowedTools when the preset is absent and the policy allow list is empty', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const noPolicy = new SessionOptionsBuilder(makeConfig()).run(makeRuntime());
    expect(noPolicy).not.toHaveProperty('allowedTools');

    const emptyPolicy = new SessionOptionsBuilder(
      makeConfig({
        harnessPolicy: {
          protectedPaths: ['bun.lock'],
          denyBashPatterns: [],
          denyReadPaths: [],
          disallowedTools: [],
          allowTools: [],
          askTools: [],
        },
      }),
    ).run(makeRuntime());
    expect(emptyPolicy).not.toHaveProperty('allowedTools');
  });

  test('a preset allowedTools passes through unchanged when the policy has no allow list', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({ allowedTools: ['Read'] }),
    ).run(makeRuntime());
    expect(options.allowedTools).toEqual(['Read']);
  });

  test('leads with the working-root directive, then the context pack, then the persona', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({
        cwd: '/repo/.nightcore/worktrees/task-1',
        appendSystemPrompt: 'You are an independent code reviewer.',
        appendContextPack: 'PROJECT CONSTITUTION: keep tests green.',
      }),
    ).run(makeRuntime());

    const appended = options.appendSystemPrompt as string;
    // The authoritative working-directory directive LEADS, naming the run cwd.
    expect(appended.startsWith('# Working directory (authoritative)')).toBe(true);
    expect(appended).toContain('/repo/.nightcore/worktrees/task-1');
    // …then the context pack, then the persona.
    expect(appended.indexOf('Working directory (authoritative)')).toBeLessThan(
      appended.indexOf('PROJECT CONSTITUTION'),
    );
    expect(appended.indexOf('PROJECT CONSTITUTION')).toBeLessThan(
      appended.indexOf('independent code reviewer'),
    );
  });

  test('always carries the working-root directive — even a bare build run (no pack, no persona)', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const options = new SessionOptionsBuilder(
      makeConfig({ cwd: '/repo/.nightcore/worktrees/task-9' }),
    ).run(makeRuntime());

    const appended = options.appendSystemPrompt as string;
    expect(appended).toContain('Working directory (authoritative)');
    expect(appended).toContain('/repo/.nightcore/worktrees/task-9');
  });

  test('carries autonomy ceilings, resume id, and checkpointing only when set', () => {
    resolvedClaudePath = '/usr/local/bin/claude';
    const full = new SessionOptionsBuilder(
      makeConfig({
        maxTurns: 12,
        maxBudgetUsd: 3.5,
        resumeSessionId: 'sdk-uuid',
        enableFileCheckpointing: true,
      }),
    ).run(makeRuntime());
    const bare = new SessionOptionsBuilder(makeConfig()).run(makeRuntime());

    expect(full.maxTurns).toBe(12);
    expect(full.maxBudgetUsd).toBe(3.5);
    expect(full.resume).toBe('sdk-uuid');
    expect(full).toHaveProperty('enableFileCheckpointing', true);

    expect(bare).not.toHaveProperty('maxTurns');
    expect(bare).not.toHaveProperty('maxBudgetUsd');
    expect(bare).not.toHaveProperty('resume');
    expect(bare).not.toHaveProperty('enableFileCheckpointing');
  });

  test('forwards outputFormat (structured output) only when the preset set it', () => {
    const outputFormat = {
      type: 'json_schema' as const,
      schema: { type: 'object', properties: {}, additionalProperties: false },
    };
    const withFormat = new SessionOptionsBuilder(
      makeConfig({ outputFormat }),
    ).run(makeRuntime());
    const bare = new SessionOptionsBuilder(makeConfig()).run(makeRuntime());

    expect(withFormat.outputFormat).toEqual(outputFormat);
    // Absent by default (every kind except decompose) — byte-identical to before.
    expect(bare).not.toHaveProperty('outputFormat');
  });
});
