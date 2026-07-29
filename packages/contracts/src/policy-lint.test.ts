/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { diagnosePolicyEntry, NATIVE_SDK_TOOLS } from './policy-lint.js';
import { compilePathRule, pathSegments, ruleProtects } from './policy-patterns.js';

/** Assert an entry is flagged at `severity`, returning the message for further
 *  assertions. */
function diagnose(
  kind: Parameters<typeof diagnosePolicyEntry>[0],
  raw: string,
  severity: 'error' | 'warning',
): string {
  const found = diagnosePolicyEntry(kind, raw);
  expect(found).not.toBeNull();
  expect(found!.severity).toBe(severity);
  return found!.message;
}

describe('path diagnostics', () => {
  test('accepts the shapes the glob engine actually implements', () => {
    for (const ok of [
      'migrations/**',
      '*.lock',
      'src/*.ts',
      '**/generated/**',
      '.env',
      'app/[id]/page.tsx',
      'docs/my notes.md',
    ]) {
      expect(diagnosePolicyEntry('path', ok)).toBeNull();
    }
  });

  test('errors on an empty entry', () => {
    diagnose('path', '   ', 'error');
  });

  test('errors on backslash separators', () => {
    expect(diagnose('path', 'src\\**', 'error')).toContain('Backslashes');
  });

  test('errors on a drive-letter or home-relative path', () => {
    diagnose('path', 'C:/proj/migrations', 'error');
    diagnose('path', '~/secrets', 'error');
  });

  test('errors on a `..` segment (never present in a repo-relative path)', () => {
    diagnose('path', '../outside/**', 'error');
  });

  test('errors on brace/question glob syntax the engine matches literally', () => {
    diagnose('path', 'migrations/{a,b}', 'error');
    diagnose('path', 'src/file?.ts', 'error');
  });

  test('errors on negation, which the engine does not implement', () => {
    diagnose('path', '!src/**', 'error');
  });

  test('warns (does not block) on a match-everything pattern', () => {
    diagnose('path', '**', 'warning');
    diagnose('path', '**/*', 'warning');
  });

  test('warns on an absolute machine path', () => {
    expect(diagnose('path', '/Users/dev/proj/migrations/**', 'warning')).toContain('REPO root');
  });

  test("every path flagged `error` really is dead against a plausible target", () => {
    // The severity contract in one assertion: an `error` entry that still
    // compiles must match nothing sane.
    const dead = compilePathRule('migrations/{a,b}');
    expect(dead).toBeDefined();
    expect(ruleProtects(dead!, pathSegments('migrations/a'))).toBe(false);
  });
});

describe('bash-regex diagnostics', () => {
  test('accepts a plain substring and a real regex', () => {
    expect(diagnosePolicyEntry('bash-regex', '--no-verify')).toBeNull();
    expect(diagnosePolicyEntry('bash-regex', 'git\\s+push\\s+--force')).toBeNull();
  });

  test('errors on an uncompilable pattern with the engine reason', () => {
    diagnose('bash-regex', '**/*.lock', 'error');
    diagnose('bash-regex', '(unclosed', 'error');
  });

  test('errors on an oversized pattern', () => {
    expect(diagnose('bash-regex', 'a'.repeat(600), 'error')).toContain('512');
  });

  test('warns when a glob was written into the regex tier', () => {
    expect(diagnose('bash-regex', '.env*', 'warning')).toContain('regex');
  });

  test('warns on `/…/` regex-literal delimiters', () => {
    expect(diagnose('bash-regex', '/--no-verify/', 'warning')).toContain('literally');
  });
});

describe('tool diagnostics', () => {
  test('accepts a known native tool and any mcp__ name', () => {
    expect(diagnosePolicyEntry('tool', 'WebSearch')).toBeNull();
    expect(diagnosePolicyEntry('tool', 'mcp__acme__push')).toBeNull();
    expect(diagnosePolicyEntry('tool', 'mcp__acme__*')).toBeNull();
  });

  test('errors on permission-rule syntax in an exact-match tier', () => {
    expect(diagnose('tool', 'Bash(git push:*)', 'error')).toContain('bare tool NAME');
  });

  test('errors on a non-MCP wildcard', () => {
    diagnose('tool', 'Web*', 'error');
  });

  test('errors on a case-variant of a real tool, naming the fix', () => {
    expect(diagnose('tool', 'websearch', 'error')).toContain('WebSearch');
  });

  test('warns (never blocks) on an unrecognized name', () => {
    diagnose('tool', 'AcmeCustomTool', 'warning');
  });

  test('every listed native tool passes its own check', () => {
    for (const tool of NATIVE_SDK_TOOLS) {
      expect(diagnosePolicyEntry('tool', tool)).toBeNull();
    }
  });
});

describe('permission-rule diagnostics', () => {
  test('accepts a bare name and a well-formed rule', () => {
    expect(diagnosePolicyEntry('permission-rule', 'WebSearch')).toBeNull();
    expect(diagnosePolicyEntry('permission-rule', 'Bash(git status:*)')).toBeNull();
  });

  test('errors on unbalanced or leading parentheses', () => {
    diagnose('permission-rule', 'Bash(git status:*', 'error');
    diagnose('permission-rule', '(git status)', 'error');
  });

  test('errors on an empty entry', () => {
    diagnose('permission-rule', '', 'error');
  });
});
