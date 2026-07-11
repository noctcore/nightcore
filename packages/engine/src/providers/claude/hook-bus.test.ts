/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type { Logger } from '@nightcore/shared';

import { HookBus } from './hook-bus.js';

function fakeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

describe('HookBus — on / unsubscribe', () => {
  test('registered observer is called when a hook fires', async () => {
    const bus = new HookBus();
    const calls: unknown[] = [];
    bus.on((event, input) => calls.push({ event, input }));

    const matcher = bus.hooks().PreToolUse![0]!;
    await matcher.hooks[0]!({ tool: 'Bash' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: 'PreToolUse' });
  });

  test('unsubscribe fn removes the observer — subsequent emit does not call it', async () => {
    const bus = new HookBus();
    const calls: unknown[] = [];
    const unsubscribe = bus.on(() => calls.push(1));

    unsubscribe();

    const matcher = bus.hooks().PreToolUse![0]!;
    await matcher.hooks[0]!({ tool: 'Bash' });

    expect(calls).toHaveLength(0);
  });
});

describe('HookBus — emit fan-out and error isolation', () => {
  test('all observers fire even when one throws', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger);

    const firstCalls: unknown[] = [];
    const lastCalls: unknown[] = [];

    bus.on(() => {
      firstCalls.push(1);
      throw new Error('observer boom');
    });
    bus.on(() => lastCalls.push(2));

    const matcher = bus.hooks().SessionStart![0]!;
    await matcher.hooks[0]!({});

    expect(firstCalls).toHaveLength(1);
    expect(lastCalls).toHaveLength(1);
  });

  test('logger.warn is called when an observer throws', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger);

    bus.on(() => {
      throw new Error('boom');
    });

    const matcher = bus.hooks().PreToolUse![0]!;
    await matcher.hooks[0]!({});

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('throwing observer does not suppress the error context passed to warn', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger);
    const boom = new Error('kaboom');

    bus.on(() => {
      throw boom;
    });

    const matcher = bus.hooks().PreToolUse![0]!;
    await matcher.hooks[0]!({});

    const [, secondArg] = (logger.warn as ReturnType<typeof mock>).mock.calls[0]!;
    expect(secondArg).toBe(boom);
  });
});

describe('HookBus — hooks() matchers', () => {
  test('hooks() provides a PreToolUse matcher', () => {
    const bus = new HookBus();
    const h = bus.hooks();
    expect(h.PreToolUse).toBeDefined();
    expect(h.PreToolUse).toHaveLength(1);
    expect(typeof h.PreToolUse![0]!.hooks[0]).toBe('function');
  });

  test('hooks() provides a SessionStart matcher', () => {
    const bus = new HookBus();
    const h = bus.hooks();
    expect(h.SessionStart).toBeDefined();
    expect(h.SessionStart).toHaveLength(1);
    expect(typeof h.SessionStart![0]!.hooks[0]).toBe('function');
  });

  test('PreToolUse callback resolves to { continue: true }', async () => {
    const bus = new HookBus();
    const result = await bus.hooks().PreToolUse![0]!.hooks[0]!({});
    expect(result).toEqual({ continue: true });
  });

  test('SessionStart callback resolves to { continue: true }', async () => {
    const bus = new HookBus();
    const result = await bus.hooks().SessionStart![0]!.hooks[0]!({});
    expect(result).toEqual({ continue: true });
  });
});

describe('HookBus — PreToolUse blocking deny gate', () => {
  /** Fire the PreToolUse hook with a tool_name/tool_input pair. */
  async function pre(bus: HookBus, toolName: string, toolInput: unknown) {
    return bus.hooks().PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
  }

  test('denies a destructive Bash command with permissionDecision: deny', async () => {
    const bus = new HookBus();
    const result = (await pre(bus, 'Bash', { command: 'rm -rf /' })) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(result.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(
      'Nightcore safety policy',
    );
  });

  test('a denied call does NOT abort the session (no continue:false)', async () => {
    const bus = new HookBus();
    const result = (await pre(bus, 'Bash', { command: 'sudo rm x' })) as Record<
      string,
      unknown
    >;
    expect(result.continue).toBeUndefined();
  });

  test('allows a benign Bash command (continue:true)', async () => {
    const bus = new HookBus();
    const result = await pre(bus, 'Bash', { command: 'bun test' });
    expect(result).toEqual({ continue: true });
  });

  test('allows a non-Bash tool call (continue:true)', async () => {
    const bus = new HookBus();
    const result = await pre(bus, 'Write', { file_path: '/etc/hosts' });
    expect(result).toEqual({ continue: true });
  });

  test('warns when a destructive call is blocked', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger);
    await pre(bus, 'Bash', { command: 'git push --force' });
    expect(logger.warn).toHaveBeenCalled();
  });

  test('observers still see the PreToolUse event even when the call is denied', async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.on((event, input) => seen.push({ event, input }));
    await pre(bus, 'Bash', { command: 'rm -rf node_modules' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'PreToolUse' });
  });

  test('custom deny rules override the default set', async () => {
    const bus = new HookBus(undefined, {
      denyRules: [
        {
          id: 'no-echo',
          reason: 'Nightcore safety policy: no echo in this test.',
          tools: ['Bash'],
          matches: (ctx) => ctx.tokens.includes('echo'),
        },
      ],
    });
    // The default rm-rf rule is replaced, so rm -rf now passes...
    expect(await pre(bus, 'Bash', { command: 'rm -rf x' })).toEqual({
      continue: true,
    });
    // ...and the custom rule fires instead.
    const blocked = (await pre(bus, 'Bash', { command: 'echo hi' })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(blocked.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('HookBus — workspace confinement gate (worktree isolation)', () => {
  async function pre(bus: HookBus, toolName: string, toolInput: unknown) {
    return bus.hooks().PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
  }
  const decision = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;

  // The exact shape of the reported bug: cwd is the task worktree, but the agent
  // edits an absolute path in the PARENT (main) checkout.
  const WORKTREE = '/repo/.nightcore/worktrees/task-1';

  test('denies an Edit whose absolute path escapes the run cwd (the main-repo write)', async () => {
    const bus = new HookBus(undefined, { cwd: WORKTREE });
    const r = await pre(bus, 'Edit', {
      file_path: '/repo/apps/web/src/components/board/status.ts',
    });
    expect(decision(r)).toBe('deny');
  });

  test('allows an Edit inside the run cwd (absolute and relative)', async () => {
    const bus = new HookBus(undefined, { cwd: WORKTREE });
    expect(
      await pre(bus, 'Edit', { file_path: `${WORKTREE}/apps/web/x.ts` }),
    ).toEqual({ continue: true });
    expect(
      await pre(bus, 'Write', { file_path: 'apps/web/y.ts' }),
    ).toEqual({ continue: true });
  });

  test('denies a Bash `cd` to an absolute path outside the run cwd', async () => {
    const bus = new HookBus(undefined, { cwd: WORKTREE });
    const r = await pre(bus, 'Bash', {
      command: 'cd /repo && bun run typecheck',
    });
    expect(decision(r)).toBe('deny');
  });

  test('with no cwd configured the confinement gate is OFF (back-compat)', async () => {
    const bus = new HookBus(undefined, {});
    expect(
      await pre(bus, 'Edit', { file_path: '/somewhere/else/x.ts' }),
    ).toEqual({ continue: true });
  });
});

describe('HookBus — harness runtime policy gate (module #3)', () => {
  async function pre(bus: HookBus, toolName: string, toolInput: unknown) {
    return bus.hooks().PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
  }
  const decision = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;
  const reason = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecisionReason?: string } })
      .hookSpecificOutput?.permissionDecisionReason;

  const CWD = '/repo';
  const POLICY = {
    protectedPaths: ['bun.lock', 'migrations/**'],
    denyBashPatterns: ['--no-verify'],
    denyReadPaths: ['.env*'],
    disallowedTools: ['WebSearch'],
    allowTools: [],
    askTools: ['WebFetch'],
  };

  test('denies a Write to a protected path with the harness-policy reason', async () => {
    const bus = new HookBus(undefined, { cwd: CWD, harnessPolicy: POLICY });
    const r = await pre(bus, 'Write', { file_path: 'migrations/002.sql' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('harness policy');
  });

  test('denies a Bash command matching a project deny pattern', async () => {
    const bus = new HookBus(undefined, { cwd: CWD, harnessPolicy: POLICY });
    const r = await pre(bus, 'Bash', { command: 'git commit --no-verify' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('--no-verify');
  });

  test('the implicit .nightcore/** self-protection holds with an empty policy', async () => {
    const bus = new HookBus(undefined, {
      cwd: CWD,
      harnessPolicy: {
        protectedPaths: [],
        denyBashPatterns: [],
        denyReadPaths: [],
        disallowedTools: [],
        allowTools: [],
        askTools: [],
      },
    });
    const r = await pre(bus, 'Edit', { file_path: '.nightcore/harness.json' });
    expect(decision(r)).toBe('deny');
  });

  test('denies a Read of a read-denied path and a disallowed tool', async () => {
    const bus = new HookBus(undefined, { cwd: CWD, harnessPolicy: POLICY });
    const r = await pre(bus, 'Read', { file_path: '.env.local' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('read-denied');
    const t = await pre(bus, 'WebSearch', { query: 'anything' });
    expect(decision(t)).toBe('deny');
    expect(reason(t)).toContain('disallowed');
  });

  test('allows unprotected work under the same policy', async () => {
    const bus = new HookBus(undefined, { cwd: CWD, harnessPolicy: POLICY });
    expect(await pre(bus, 'Write', { file_path: 'src/app.ts' })).toEqual({
      continue: true,
    });
    expect(await pre(bus, 'Bash', { command: 'git commit -m ok' })).toEqual({
      continue: true,
    });
  });

  test('the destructive deny list still wins first (rule id precedence)', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger, { cwd: CWD, harnessPolicy: POLICY });
    const r = await pre(bus, 'Bash', { command: 'rm -rf / --no-verify' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('Nightcore safety policy');
  });

  test('without a harnessPolicy the gate is OFF (back-compat)', async () => {
    const bus = new HookBus(undefined, { cwd: CWD });
    expect(
      await pre(bus, 'Write', { file_path: 'migrations/002.sql' }),
    ).toEqual({ continue: true });
    expect(await pre(bus, 'Bash', { command: 'git commit --no-verify' })).toEqual({
      continue: true,
    });
  });

  test('a policy WITHOUT cwd still enforces Bash rules', async () => {
    const bus = new HookBus(undefined, { harnessPolicy: POLICY });
    const r = await pre(bus, 'Bash', { command: 'git commit --no-verify' });
    expect(decision(r)).toBe('deny');
  });

  test('an askTools match returns the SDK ask decision shape', async () => {
    const bus = new HookBus(undefined, { cwd: CWD, harnessPolicy: POLICY });
    const r = (await pre(bus, 'WebFetch', { url: 'https://example.com' })) as {
      continue?: unknown;
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(r.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(r.hookSpecificOutput?.permissionDecision).toBe('ask');
    expect(r.hookSpecificOutput?.permissionDecisionReason).toContain(
      'interactive approval',
    );
    // An ask must not abort the session either.
    expect(r.continue).toBeUndefined();
  });

  test('ask does not shadow a deny — a tool in both lists is denied', async () => {
    const bus = new HookBus(undefined, {
      cwd: CWD,
      harnessPolicy: { ...POLICY, askTools: ['WebSearch', 'Write'] },
    });
    // WebSearch is disallowed AND asked-for: deny wins.
    const t = await pre(bus, 'WebSearch', { query: 'x' });
    expect(decision(t)).toBe('deny');
    // Write is asked-for, but a protected-path target still hard-denies…
    const w = await pre(bus, 'Write', { file_path: 'bun.lock' });
    expect(decision(w)).toBe('deny');
    // …while an unprotected target escalates to ask.
    const ok = await pre(bus, 'Write', { file_path: 'src/app.ts' });
    expect(decision(ok)).toBe('ask');
  });
});

describe('HookBus — execution-sink write protection gate (issue #142)', () => {
  async function pre(bus: HookBus, toolName: string, toolInput: unknown) {
    return bus.hooks().PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
  }
  const decision = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision;
  const reason = (r: unknown) =>
    (r as { hookSpecificOutput?: { permissionDecisionReason?: string } })
      .hookSpecificOutput?.permissionDecisionReason;

  const CWD = '/repo';
  const WORKTREE = '/repo/.nightcore/worktrees/task-1';

  test('escalates a workflow write to ask under the DEFAULT config (no harness policy)', async () => {
    // The whole point: with NO manifest (default), a write that changes how code
    // executes is held for approval. `decidePreToolUse` never consults
    // permissionMode, so this ask fires the same under `bypassPermissions` — which
    // the SDK forwards to the host's `canUseTool` (see the gate docs).
    const bus = new HookBus(undefined, { cwd: CWD });
    const r = await pre(bus, 'Write', { file_path: '.github/workflows/evil.yml' });
    expect(decision(r)).toBe('ask');
    expect(reason(r)).toContain('execute');
  });

  test('escalates the Bash redirect vector into a Claude config sink', async () => {
    const bus = new HookBus(undefined, { cwd: CWD });
    const r = await pre(bus, 'Bash', {
      command: 'echo "{}" > .claude/settings.local.json',
    });
    expect(decision(r)).toBe('ask');
  });

  test('an out-of-cwd sink write stays DENIED by confinement, not downgraded to ask', async () => {
    // A worktree session writing the MAIN checkout's workflow via an absolute
    // parent path: confinement (gate 2) denies it BEFORE the exec-sink gate, so a
    // deny is never softened to an ask.
    const bus = new HookBus(undefined, { cwd: WORKTREE });
    const r = await pre(bus, 'Write', {
      file_path: '/repo/.github/workflows/evil.yml',
    });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('worktree isolation');
  });

  test('a project protectedPaths sink hard-denies — deny wins over the exec-sink ask', async () => {
    const bus = new HookBus(undefined, {
      cwd: CWD,
      harnessPolicy: {
        protectedPaths: ['.github/**'],
        denyBashPatterns: [],
        denyReadPaths: [],
        disallowedTools: [],
        allowTools: [],
        askTools: [],
      },
    });
    const r = await pre(bus, 'Write', { file_path: '.github/workflows/ci.yml' });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('harness policy');
  });

  test('the destructive deny list still wins over an exec-sink write', async () => {
    const bus = new HookBus(undefined, { cwd: CWD });
    const r = await pre(bus, 'Bash', {
      command: 'rm -rf / ; echo x > package.json',
    });
    expect(decision(r)).toBe('deny');
    expect(reason(r)).toContain('Nightcore safety policy');
  });

  test('a per-project allowExecSinks downgrades that sink to a silent allow', async () => {
    const bus = new HookBus(undefined, {
      cwd: CWD,
      harnessPolicy: {
        protectedPaths: [],
        denyBashPatterns: [],
        denyReadPaths: [],
        disallowedTools: [],
        allowTools: [],
        askTools: [],
        allowExecSinks: ['.github/workflows/**'],
      },
    });
    // The allowed sink proceeds without a prompt…
    expect(
      await pre(bus, 'Write', { file_path: '.github/workflows/ci.yml' }),
    ).toEqual({ continue: true });
    // …but a sink NOT on the allow list is still held.
    expect(decision(await pre(bus, 'Write', { file_path: 'package.json' }))).toBe(
      'ask',
    );
  });

  test('an ordinary source write is unaffected by the gate', async () => {
    const bus = new HookBus(undefined, { cwd: CWD });
    expect(await pre(bus, 'Write', { file_path: 'src/foo.ts' })).toEqual({
      continue: true,
    });
  });

  test('records the exec-sink ask on the flight recorder with its rule id', async () => {
    const seen: { tool: string; decision: string; ruleId?: string }[] = [];
    const bus = new HookBus(undefined, {
      cwd: CWD,
      onToolDecision: (tool, _input, d, ruleId) =>
        seen.push({ tool, decision: d, ...(ruleId !== undefined ? { ruleId } : {}) }),
    });
    await pre(bus, 'Write', { file_path: 'package.json' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tool: 'Write',
      decision: 'ask',
      ruleId: 'exec-sink-ask',
    });
  });
});

describe('HookBus — onToolDecision flight-recorder seam (module #5)', () => {
  async function pre(bus: HookBus, toolName: string, toolInput: unknown) {
    return bus.hooks().PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
  }

  const CWD = '/repo';
  const POLICY = {
    protectedPaths: ['migrations/**'],
    denyBashPatterns: [],
    denyReadPaths: [],
    disallowedTools: [],
    allowTools: [],
    askTools: [],
  };

  type Seen = { tool: string; input: unknown; decision: string; ruleId?: string };

  test('records an allow (no ruleId) and a deny (with the matched ruleId)', async () => {
    const seen: Seen[] = [];
    const bus = new HookBus(undefined, {
      cwd: CWD,
      harnessPolicy: POLICY,
      onToolDecision: (tool, input, decision, ruleId) =>
        seen.push({ tool, input, decision, ...(ruleId !== undefined ? { ruleId } : {}) }),
    });

    await pre(bus, 'Bash', { command: 'bun test' });
    await pre(bus, 'Write', { file_path: 'migrations/002.sql' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      tool: 'Bash',
      input: { command: 'bun test' },
      decision: 'allow',
    });
    expect(seen[0]!.ruleId).toBeUndefined();
    expect(seen[1]).toMatchObject({
      tool: 'Write',
      decision: 'deny',
      ruleId: 'harness-protected-path',
    });
  });

  test('a throwing observer is fail-open: the call still allows/denies normally', async () => {
    const logger = fakeLogger();
    const bus = new HookBus(logger, {
      cwd: CWD,
      harnessPolicy: POLICY,
      onToolDecision: () => {
        throw new Error('recorder exploded');
      },
    });

    // Allow path unaffected.
    expect(await pre(bus, 'Bash', { command: 'bun test' })).toEqual({
      continue: true,
    });
    // Deny path unaffected.
    const denied = (await pre(bus, 'Write', {
      file_path: 'migrations/002.sql',
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('malformed input (no tool_name) records nothing', async () => {
    const seen: unknown[] = [];
    const bus = new HookBus(undefined, {
      onToolDecision: (...args) => seen.push(args),
    });
    await bus.hooks().PreToolUse![0]!.hooks[0]!({ nonsense: true });
    expect(seen).toHaveLength(0);
  });
});
