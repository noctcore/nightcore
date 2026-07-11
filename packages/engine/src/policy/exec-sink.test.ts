/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type CompiledExecSinkGate,
  compileExecSinkGate,
  evaluateExecSinkGate,
  EXEC_SINK_ASK_RULE_ID,
  EXEC_SINK_PATTERNS,
} from './exec-sink.js';

const CWD = '/repo';
const GATE = compileExecSinkGate(); // no per-project allowances

/** True when the gate escalates this call to an interactive ask. */
function asks(
  toolName: string,
  input: unknown,
  cwd = CWD,
  gate: CompiledExecSinkGate = GATE,
): boolean {
  const v = evaluateExecSinkGate(toolName, input, cwd, gate);
  return v.ask === true && v.denied === false;
}

describe('exec-sink gate — every sink asks, for every write tool', () => {
  // path (or subpath) → must escalate. Covers each documented sink + a subpath.
  const SINKS = [
    '.github/workflows/ci.yml',
    '.github/workflows/nested/deep.yml', // subpath under an anchored dir sink
    '.github/actions/build/action.yml',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/pre-tool.sh', // subpath under .claude
    '.claude/skills/foo/SKILL.md',
    '.git/hooks/pre-commit',
    '.husky/pre-commit',
    'package.json',
    'apps/web/package.json', // floating: a nested manifest is a sink too
    '.envrc',
    'services/api/.envrc', // floating at depth
    '.mise.toml',
  ];

  for (const p of SINKS) {
    test(`Write ${p} → ask`, () => {
      const v = evaluateExecSinkGate('Write', { file_path: p }, CWD, GATE);
      expect(v.ask).toBe(true);
      expect(v.denied).toBe(false);
      expect(v.ruleId).toBe(EXEC_SINK_ASK_RULE_ID);
      expect(v.reason).toContain('execute');
    });
  }

  test('every native mutation tool escalates a sink write', () => {
    expect(asks('Write', { file_path: '.github/workflows/x.yml' })).toBe(true);
    expect(asks('Edit', { file_path: 'package.json' })).toBe(true);
    expect(asks('MultiEdit', { file_path: '.claude/settings.json' })).toBe(true);
    expect(asks('NotebookEdit', { notebook_path: '.husky/pre-commit' })).toBe(true);
  });

  test('an ApplyPatch body that adds a workflow escalates', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: .github/workflows/evil.yml',
      '*** End Patch',
    ].join('\n');
    expect(asks('ApplyPatch', { patch })).toBe(true);
  });

  test('an ApplyPatch that touches ANY sink among many targets escalates', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Update File: package.json', // the sink hidden in a multi-file patch
      '*** End Patch',
    ].join('\n');
    expect(asks('ApplyPatch', { patch })).toBe(true);
  });
});

describe('exec-sink gate — ordinary writes are unaffected', () => {
  const ALLOWED = [
    'src/foo.ts',
    'apps/web/src/components/board/Board.tsx',
    'README.md',
    '.gitignore',
    '.eslintrc.json',
    '.github/dependabot.yml', // .github but NOT workflows/actions
    '.github/ISSUE_TEMPLATE/bug.md',
    'docs/package.json.md', // a lookalike filename, not package.json
    'claudecfg.json', // not under .claude/
    'packages/foo/tsconfig.json',
  ];
  for (const p of ALLOWED) {
    test(`Write ${p} → no ask`, () => {
      expect(asks('Write', { file_path: p })).toBe(false);
    });
  }

  test('a read tool is not a write and never asks', () => {
    expect(asks('Read', { file_path: 'package.json' })).toBe(false);
    expect(asks('Grep', { path: '.github/workflows' })).toBe(false);
  });

  test('empty cwd disables the gate entirely', () => {
    expect(asks('Write', { file_path: '.github/workflows/x.yml' }, '')).toBe(false);
  });
});

describe('exec-sink gate — Bash write vectors', () => {
  const VECTORS = [
    'echo "on: push" > .github/workflows/y.yml', // redirect (relative)
    'echo "{}" >> package.json', // append redirect
    'echo x > /repo/.github/workflows/abs.yml', // absolute, but INSIDE cwd
    'tee .claude/settings.json', // tee destination
    'cp evil.yml .github/workflows/ci.yml', // cp destination
    'mv tmp package.json', // mv destination
    "sh -c 'echo x > .husky/pre-commit'", // subshell recursion
  ];
  for (const cmd of VECTORS) {
    test(`Bash \`${cmd}\` → ask`, () => {
      expect(asks('Bash', { command: cmd })).toBe(true);
    });
  }

  const BENIGN = [
    'echo hi > out.txt', // ordinary in-cwd write
    'cat package.json', // a READ, not a write target
    'git commit -m "ok"', // no write vector
    'rm -rf build', // deletion is the deny list's job, not a sink write
    'echo x > $DIR/.github/workflows/y.yml', // dynamic target — documented gap, skipped
  ];
  for (const cmd of BENIGN) {
    test(`Bash \`${cmd}\` → no ask`, () => {
      expect(asks('Bash', { command: cmd })).toBe(false);
    });
  }
});

describe('exec-sink gate — root resolution (main vs worktree, out-of-root)', () => {
  const WORKTREE = '/repo/.nightcore/worktrees/task-1';

  test('a sink inside a WORKTREE cwd asks (relative + absolute)', () => {
    expect(asks('Write', { file_path: '.github/workflows/x.yml' }, WORKTREE)).toBe(true);
    expect(
      asks('Write', { file_path: `${WORKTREE}/package.json` }, WORKTREE),
    ).toBe(true);
  });

  test('an OUT-OF-ROOT sink target is NOT this gate’s to ask (confinement denies it)', () => {
    // The gate never matches a target outside cwd, so it can never downgrade the
    // confinement deny that fires first in the HookBus to a mere ask.
    expect(asks('Write', { file_path: '/other/.github/workflows/x.yml' }, CWD)).toBe(
      false,
    );
    expect(asks('Bash', { command: 'echo x > /other/.github/workflows/x.yml' })).toBe(
      false,
    );
  });
});

describe('exec-sink gate — per-project allowExecSinks downgrade', () => {
  test('an anchored allowance downgrades exactly that sink, not the others', () => {
    const gate = compileExecSinkGate(['.github/workflows/**']);
    expect(asks('Write', { file_path: '.github/workflows/ci.yml' }, CWD, gate)).toBe(
      false,
    );
    // A different sink is still held.
    expect(asks('Write', { file_path: '.claude/settings.json' }, CWD, gate)).toBe(true);
    expect(asks('Write', { file_path: 'package.json' }, CWD, gate)).toBe(true);
  });

  test('a floating allowance downgrades the sink at any depth', () => {
    const gate = compileExecSinkGate(['package.json']);
    expect(asks('Write', { file_path: 'package.json' }, CWD, gate)).toBe(false);
    expect(asks('Write', { file_path: 'apps/web/package.json' }, CWD, gate)).toBe(false);
  });

  test('the downgrade covers the Bash vector too', () => {
    const gate = compileExecSinkGate(['.github/workflows/**']);
    expect(asks('Bash', { command: 'echo x > .github/workflows/y.yml' }, CWD, gate)).toBe(
      false,
    );
  });

  test('an empty/invalid allowance pattern never widens the allow (fails safe)', () => {
    const gate = compileExecSinkGate(['', '   ']);
    expect(asks('Write', { file_path: '.github/workflows/x.yml' }, CWD, gate)).toBe(true);
  });
});

describe('exec-sink gate — the denylist constant is intact', () => {
  test('EXEC_SINK_PATTERNS covers the documented execution sinks', () => {
    // A guard so the auditable constant can’t be silently emptied/trimmed.
    for (const p of [
      '.github/workflows/**',
      '.github/actions/**',
      '.claude/**',
      '.git/hooks/**',
      '.husky/**',
      'package.json',
      '.envrc',
      '.mise.toml',
    ]) {
      expect(EXEC_SINK_PATTERNS).toContain(p);
    }
  });
});
