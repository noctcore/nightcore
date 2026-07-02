/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type { Logger } from '@nightcore/shared';

import {
  BASH_COMMAND_SCAN_LIMIT,
  type CompiledHarnessPolicy,
  compileHarnessPolicy,
  evaluateHarnessPolicy,
  HARNESS_BASH_DENY_RULE_ID,
  HARNESS_PROTECTED_PATH_RULE_ID,
  HARNESS_READ_DENY_RULE_ID,
  HARNESS_TOOL_ASK_RULE_ID,
  HARNESS_TOOL_DENY_RULE_ID,
  MANIFEST_PROTECTED_PATTERN,
  MAX_BASH_PATTERN_LENGTH,
} from './harness-policy.js';

const CWD = '/repo';

function fakeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

function compiled(
  protectedPaths: string[] = [],
  denyBashPatterns: string[] = [],
  logger?: Logger,
  denyReadPaths: string[] = [],
  disallowedTools: string[] = [],
  askTools: string[] = [],
  allowTools: string[] = [],
): CompiledHarnessPolicy {
  return compileHarnessPolicy(
    {
      protectedPaths,
      denyBashPatterns,
      denyReadPaths,
      disallowedTools,
      allowTools,
      askTools,
    },
    logger,
  );
}

function write(policy: CompiledHarnessPolicy, filePath: string, cwd: string | undefined = CWD) {
  return evaluateHarnessPolicy('Write', { file_path: filePath }, policy, cwd);
}

function bash(policy: CompiledHarnessPolicy, command: string, cwd: string | undefined = CWD) {
  return evaluateHarnessPolicy('Bash', { command }, policy, cwd);
}

function read(policy: CompiledHarnessPolicy, filePath: string, cwd: string | undefined = CWD) {
  return evaluateHarnessPolicy('Read', { file_path: filePath }, policy, cwd);
}

describe('protected paths — anchored patterns', () => {
  test('a glob pattern blocks a matching write and allows a non-match', () => {
    const policy = compiled(['migrations/**']);
    expect(write(policy, 'migrations/001_init.sql').denied).toBe(true);
    expect(write(policy, 'migrations/001_init.sql').ruleId).toBe(
      HARNESS_PROTECTED_PATH_RULE_ID,
    );
    expect(write(policy, 'src/app.ts').denied).toBe(false);
  });

  test('a non-glob anchored pattern protects its whole subtree', () => {
    const policy = compiled(['src/generated']);
    expect(write(policy, 'src/generated/api.ts').denied).toBe(true);
    expect(write(policy, 'src/generated').denied).toBe(true);
    expect(write(policy, 'src/generate/api.ts').denied).toBe(false);
    // `/repo/src/generated-extra` must not match `src/generated` (segment, not prefix).
    expect(write(policy, 'src/generated-extra/api.ts').denied).toBe(false);
  });

  test('an absolute in-cwd target is matched repo-relative', () => {
    const policy = compiled(['bun.lock']);
    expect(write(policy, '/repo/bun.lock').denied).toBe(true);
  });

  test('`**` in the middle of a pattern spans segments', () => {
    const policy = compiled(['packages/**/generated/**']);
    expect(write(policy, 'packages/a/b/generated/x.ts').denied).toBe(true);
    expect(write(policy, 'packages/a/generated/x.ts').denied).toBe(true);
    expect(write(policy, 'packages/a/src/x.ts').denied).toBe(false);
  });

  test('`*` matches within a segment only', () => {
    const policy = compiled(['*.sql']);
    // Floating basename pattern: any depth.
    expect(write(policy, 'db/001.sql').denied).toBe(true);
    const anchored = compiled(['db/*.sql']);
    expect(write(anchored, 'db/001.sql').denied).toBe(true);
    expect(write(anchored, 'db/deep/001.sql').denied).toBe(false);
  });
});

describe('protected paths — floating patterns', () => {
  test('a bare filename pattern matches at any depth', () => {
    const policy = compiled(['bun.lock']);
    expect(write(policy, 'bun.lock').denied).toBe(true);
    expect(write(policy, 'packages/web/bun.lock').denied).toBe(true);
    expect(write(policy, 'src/app.ts').denied).toBe(false);
  });

  test('a floating glob matches lockfiles anywhere', () => {
    const policy = compiled(['*.lock']);
    expect(write(policy, 'deep/nested/Cargo.lock').denied).toBe(true);
    expect(write(policy, 'deep/nested/cargo.toml').denied).toBe(false);
  });

  test('matching is case-insensitive (case-variant writes cannot slip through)', () => {
    const policy = compiled(['bun.lock']);
    expect(write(policy, 'BUN.LOCK').denied).toBe(true);
  });
});

describe('protected paths — implicit self-protection', () => {
  test('.nightcore/** is protected even with an EMPTY policy', () => {
    const policy = compiled([]);
    const verdict = write(policy, '.nightcore/harness.json');
    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain(MANIFEST_PROTECTED_PATTERN);
    expect(write(policy, '.nightcore/tasks/t1.json').denied).toBe(true);
  });

  test('Edit / MultiEdit / NotebookEdit are covered like Write', () => {
    const policy = compiled([]);
    for (const tool of ['Edit', 'MultiEdit']) {
      const verdict = evaluateHarnessPolicy(
        tool,
        { file_path: '.nightcore/harness.json' },
        policy,
        CWD,
      );
      expect(verdict.denied).toBe(true);
    }
    const notebook = evaluateHarnessPolicy(
      'NotebookEdit',
      { notebook_path: '.nightcore/harness.json' },
      policy,
      CWD,
    );
    expect(notebook.denied).toBe(true);
  });
});

describe('protected paths — jurisdiction boundaries', () => {
  test('a target OUTSIDE the run cwd is left alone (confinement owns it)', () => {
    const policy = compiled(['bun.lock']);
    expect(write(policy, '/elsewhere/bun.lock').denied).toBe(false);
    // The `/repo-evil` prefix trick resolves outside `/repo` — not ours to judge.
    expect(write(policy, '/repo-evil/bun.lock').denied).toBe(false);
    // `..` traversal that escapes the cwd is confinement's catch too.
    expect(write(policy, '../outside/bun.lock').denied).toBe(false);
  });

  test('`..` traversal that stays inside the cwd is still matched', () => {
    const policy = compiled(['bun.lock']);
    expect(write(policy, 'src/../bun.lock').denied).toBe(true);
  });

  test('an unreadable target is left alone (confinement fail-closes it first)', () => {
    const policy = compiled(['bun.lock']);
    expect(evaluateHarnessPolicy('Write', {}, policy, CWD).denied).toBe(false);
    expect(evaluateHarnessPolicy('Write', null, policy, CWD).denied).toBe(false);
  });

  test('path rules are skipped without a cwd (nothing to resolve against)', () => {
    const policy = compiled(['bun.lock']);
    // Call directly: the `write` helper's default param would re-supply a cwd.
    const verdict = evaluateHarnessPolicy(
      'Write',
      { file_path: 'bun.lock' },
      policy,
      undefined,
    );
    expect(verdict.denied).toBe(false);
  });

  test('non-mutation tools are never path-checked', () => {
    const policy = compiled(['bun.lock']);
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch']) {
      const verdict = evaluateHarnessPolicy(
        tool,
        { file_path: 'bun.lock' },
        policy,
        CWD,
      );
      expect(verdict.denied).toBe(false);
    }
  });
});

describe('bash deny patterns', () => {
  test('a matching command is denied with the pattern in the reason', () => {
    const policy = compiled([], ['--no-verify']);
    const verdict = bash(policy, 'git commit --no-verify -m "wip"');
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(HARNESS_BASH_DENY_RULE_ID);
    expect(verdict.reason).toContain('--no-verify');
  });

  test('a non-matching command is allowed', () => {
    const policy = compiled([], ['--no-verify']);
    expect(bash(policy, 'git commit -m "ok"').denied).toBe(false);
  });

  test('patterns are real regexes', () => {
    const policy = compiled([], ['npm\\s+install\\s+(?!--package-lock-only)']);
    expect(bash(policy, 'npm install left-pad').denied).toBe(true);
    expect(bash(policy, 'npm install --package-lock-only').denied).toBe(false);
  });

  test('bash rules enforce even without a cwd', () => {
    const policy = compiled([], ['--no-verify']);
    // Call directly: the `bash` helper's default param would re-supply a cwd.
    const verdict = evaluateHarnessPolicy(
      'Bash',
      { command: 'git commit --no-verify' },
      policy,
      undefined,
    );
    expect(verdict.denied).toBe(true);
  });

  test('an invalid regex is warn-and-skipped; valid rules still enforce', () => {
    const logger = fakeLogger();
    const policy = compiled([], ['(unclosed', '--no-verify'], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(policy.bashRules).toHaveLength(1);
    expect(bash(policy, 'git commit --no-verify').denied).toBe(true);
  });

  test('a bash command with no protected-path relevance is not path-checked', () => {
    // Bash is NOT confined by protectedPaths (documented residual gap) — only
    // denyBashPatterns govern it.
    const policy = compiled(['bun.lock'], []);
    expect(bash(policy, 'echo x > bun.lock').denied).toBe(false);
  });
});

describe('compile hygiene', () => {
  test('empty / degenerate path patterns are skipped, not fatal', () => {
    const logger = fakeLogger();
    const policy = compiled(['', '   ', '/'], [], logger);
    // Only the implicit manifest rule survives.
    expect(policy.pathRules).toHaveLength(1);
    expect(policy.pathRules[0]!.pattern).toBe(MANIFEST_PROTECTED_PATTERN);
  });

  test('author sugar is tolerated: leading ./ or / and a trailing /', () => {
    const policy = compiled(['./migrations/', '/src/generated/']);
    expect(write(policy, 'migrations/001.sql').denied).toBe(true);
    expect(write(policy, 'src/generated/api.ts').denied).toBe(true);
  });

  test('regex metacharacters in a path pattern are literal', () => {
    const policy = compiled(['file.(x)+?.ts']);
    expect(write(policy, 'file.(x)+?.ts').denied).toBe(true);
    expect(write(policy, 'fileA(x)Bts').denied).toBe(false);
  });
});

describe('read-denial (modules #4/#12)', () => {
  test('a denyReadPaths glob blocks a matching Read and allows others', () => {
    const policy = compiled([], [], undefined, ['.env*', 'secrets/**']);
    const denied = read(policy, '.env');
    expect(denied.denied).toBe(true);
    expect(denied.ruleId).toBe(HARNESS_READ_DENY_RULE_ID);
    expect(read(policy, '.env.local').denied).toBe(true);
    expect(read(policy, 'secrets/api-key.txt').denied).toBe(true);
    expect(read(policy, 'src/app.ts').denied).toBe(false);
  });

  test('read rules do not gate mutation tools and vice versa', () => {
    // A read-denied path stays WRITABLE unless also protected (disjoint rule
    // sets, one owner per channel) — and a protected path stays readable.
    const policy = compiled(['bun.lock'], [], undefined, ['.env*']);
    expect(write(policy, '.env').denied).toBe(false);
    expect(read(policy, 'bun.lock').denied).toBe(false);
  });

  test('floating patterns match at any depth, like protectedPaths', () => {
    const policy = compiled([], [], undefined, ['.env*']);
    expect(read(policy, 'apps/web/.env.production').denied).toBe(true);
  });

  test('Grep/Glob with an explicit denied path are refused; rootless stay allowed', () => {
    const policy = compiled([], [], undefined, ['secrets/**']);
    expect(
      evaluateHarnessPolicy('Grep', { pattern: 'key', path: 'secrets' }, policy, CWD)
        .denied,
    ).toBe(true);
    expect(
      evaluateHarnessPolicy('Glob', { pattern: '**/*.txt', path: 'secrets' }, policy, CWD)
        .denied,
    ).toBe(true);
    // No explicit path ⇒ lexically undecidable ⇒ allowed (documented gap).
    expect(
      evaluateHarnessPolicy('Grep', { pattern: 'key' }, policy, CWD).denied,
    ).toBe(false);
  });

  test('an out-of-cwd read target is left to the confinement read guard', () => {
    const policy = compiled([], [], undefined, ['.env*']);
    expect(read(policy, '/other/.env').denied).toBe(false);
  });

  test('reads are skipped entirely without a cwd', () => {
    const policy = compiled([], [], undefined, ['.env*']);
    expect(
      evaluateHarnessPolicy('Read', { file_path: '.env' }, policy, undefined).denied,
    ).toBe(false);
  });

  test('the manifest is NOT implicitly read-denied (write-protection only)', () => {
    const policy = compiled([], [], undefined, ['.env*']);
    expect(read(policy, '.nightcore/harness.json').denied).toBe(false);
  });
});

describe('least-privilege tool denial (module #9)', () => {
  test('a disallowed tool is denied regardless of input', () => {
    const policy = compiled([], [], undefined, [], ['WebSearch']);
    const denied = evaluateHarnessPolicy('WebSearch', { query: 'x' }, policy, CWD);
    expect(denied.denied).toBe(true);
    expect(denied.ruleId).toBe(HARNESS_TOOL_DENY_RULE_ID);
  });

  test('tool denial needs no cwd and matches exact names only', () => {
    const policy = compiled([], [], undefined, [], ['mcp__acme__push']);
    expect(
      evaluateHarnessPolicy('mcp__acme__push', {}, policy, undefined).denied,
    ).toBe(true);
    expect(
      evaluateHarnessPolicy('mcp__acme__pull', {}, policy, undefined).denied,
    ).toBe(false);
  });

  test('a disallowed mutation tool is denied by the tool rule, not path rules', () => {
    const policy = compiled(['bun.lock'], [], undefined, [], ['Write']);
    const denied = write(policy, 'src/app.ts');
    expect(denied.denied).toBe(true);
    expect(denied.ruleId).toBe(HARNESS_TOOL_DENY_RULE_ID);
  });

  test('empty/whitespace tool entries are skipped at compile', () => {
    const logger = fakeLogger();
    const policy = compiled([], [], logger, [], ['', '  ', 'WebSearch']);
    expect(policy.disallowedTools.size).toBe(1);
  });
});

describe('interactive ask tier (module #9)', () => {
  test('an askTools match escalates with ask: true and the ask rule id', () => {
    const policy = compiled([], [], undefined, [], [], ['WebFetch']);
    const verdict = evaluateHarnessPolicy('WebFetch', { url: 'x' }, policy, CWD);
    expect(verdict.denied).toBe(false);
    expect(verdict.ask).toBe(true);
    expect(verdict.ruleId).toBe(HARNESS_TOOL_ASK_RULE_ID);
    expect(verdict.reason).toContain('interactive approval');
  });

  test('ask needs no cwd and matches exact names only', () => {
    const policy = compiled([], [], undefined, [], [], ['mcp__acme__push']);
    expect(
      evaluateHarnessPolicy('mcp__acme__push', {}, policy, undefined).ask,
    ).toBe(true);
    expect(
      evaluateHarnessPolicy('mcp__acme__pull', {}, policy, undefined).ask,
    ).toBeUndefined();
  });

  test('a tool in both disallowedTools and askTools is DENIED (deny wins)', () => {
    const logger = fakeLogger();
    const policy = compiled([], [], logger, [], ['WebSearch'], ['WebSearch']);
    const verdict = evaluateHarnessPolicy('WebSearch', {}, policy, CWD);
    expect(verdict.denied).toBe(true);
    expect(verdict.ask).toBeUndefined();
    expect(verdict.ruleId).toBe(HARNESS_TOOL_DENY_RULE_ID);
    // The dead ask entry is called out at compile so the author learns
    // it is not a softer deny.
    expect(logger.warn).toHaveBeenCalled();
  });

  test('an askTools entry cannot shadow a protected-path deny', () => {
    const policy = compiled(['bun.lock'], [], undefined, [], [], ['Write']);
    const denied = write(policy, 'bun.lock');
    expect(denied.denied).toBe(true);
    expect(denied.ask).toBeUndefined();
    expect(denied.ruleId).toBe(HARNESS_PROTECTED_PATH_RULE_ID);
    // …but an unprotected write by the same tool still asks.
    const asked = write(policy, 'src/app.ts');
    expect(asked.denied).toBe(false);
    expect(asked.ask).toBe(true);
  });

  test('an askTools entry cannot shadow a Bash deny pattern or a read deny', () => {
    const policy = compiled(
      [],
      ['--no-verify'],
      undefined,
      ['.env*'],
      [],
      ['Bash', 'Read'],
    );
    const bashDenied = bash(policy, 'git commit --no-verify');
    expect(bashDenied.denied).toBe(true);
    expect(bashDenied.ask).toBeUndefined();
    const readDenied = read(policy, '.env');
    expect(readDenied.denied).toBe(true);
    expect(readDenied.ask).toBeUndefined();
    // Non-matching inputs by the same tools escalate to ask.
    expect(bash(policy, 'git commit -m ok').ask).toBe(true);
    expect(read(policy, 'src/app.ts').ask).toBe(true);
  });

  test('empty/whitespace ask entries are skipped at compile', () => {
    const logger = fakeLogger();
    const policy = compiled([], [], logger, [], [], ['', '  ', 'WebFetch']);
    expect(policy.askTools.size).toBe(1);
  });

  test('allowTools is NOT compiled into the hook policy (SDK-side only)', () => {
    const policy = compiled([], [], undefined, [], [], [], ['WebSearch']);
    // An allow entry must not produce any hook opinion — and must never
    // override a deny elsewhere in the policy.
    expect(evaluateHarnessPolicy('WebSearch', {}, policy, CWD)).toEqual({
      denied: false,
    });
  });
});

describe('regex-guard caps (module #3 hardening)', () => {
  test('a pattern over MAX_BASH_PATTERN_LENGTH is warn-and-skipped; valid rules enforce', () => {
    const logger = fakeLogger();
    const oversized = 'a'.repeat(MAX_BASH_PATTERN_LENGTH + 1);
    const policy = compiled([], [oversized, '--no-verify'], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(policy.bashRules).toHaveLength(1);
    expect(bash(policy, 'git commit --no-verify').denied).toBe(true);
  });

  test('a pattern exactly at the cap still compiles', () => {
    const policy = compiled([], ['b'.repeat(MAX_BASH_PATTERN_LENGTH)]);
    expect(policy.bashRules).toHaveLength(1);
  });

  test('only the first 16 KiB of a command are tested (match past the cap fails open)', () => {
    const policy = compiled([], ['--no-verify']);
    const pastCap = `${'x'.repeat(BASH_COMMAND_SCAN_LIMIT)} --no-verify`;
    expect(bash(policy, pastCap).denied).toBe(false);
    const withinCap = `--no-verify ${'x'.repeat(BASH_COMMAND_SCAN_LIMIT)}`;
    expect(bash(policy, withinCap).denied).toBe(true);
  });

  test('a match straddling the cap boundary does not fire (sliced input)', () => {
    const policy = compiled([], ['--no-verify']);
    // Place the pattern so it starts before the cap but completes after it.
    const prefix = 'y'.repeat(BASH_COMMAND_SCAN_LIMIT - 4);
    expect(bash(policy, `${prefix}--no-verify`).denied).toBe(false);
  });
});
