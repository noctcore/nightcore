/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  extractRuleInventory,
  parseDocClaims,
  parseEslintRuleIds,
} from './inventory.js';

/**
 * Drive the deterministic ENFORCE-lite rule-inventory extraction against real
 * tmp-dir fixtures. No Claude, no SDK — pure fs, best-effort textual parsing.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-inventory-'));
  dirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('parseEslintRuleIds', () => {
  test('extracts plugin + core rule ids wired at error|warn (string and numeric)', () => {
    const config = `
      export default [{
        rules: {
          'nightcore/no-cross-feature-imports': 'error',
          "@typescript-eslint/no-explicit-any": ['warn', {}],
          'no-console': 2,
          'eqeqeq': 1,
          'max-lines': ['error', 500],
        },
      }];
    `;
    const ids = parseEslintRuleIds(config);
    expect(ids).toContain('nightcore/no-cross-feature-imports');
    expect(ids).toContain('@typescript-eslint/no-explicit-any');
    expect(ids).toContain('no-console');
    expect(ids).toContain('eqeqeq'); // numeric 1 (warn)
    expect(ids).toContain('max-lines');
  });

  test('ignores rules set to off and camelCase config keys', () => {
    const config = `
      export default [{
        languageOptions: { ecmaVersion: 'latest' },
        rules: { 'no-debugger': 'off', 'no-unused-vars': 0 },
      }];
    `;
    const ids = parseEslintRuleIds(config);
    expect(ids).not.toContain('no-debugger');
    expect(ids).not.toContain('ecmaVersion');
  });
});

describe('parseDocClaims', () => {
  test('extracts headings and bullet rules, stripped of markdown', () => {
    const doc = [
      '# Agent guide',
      '',
      'Some prose that is not a claim.',
      '## Folder structure',
      '- Components are `folder-per-component`.',
      '* No cross-feature imports.',
    ].join('\n');
    const claims = parseDocClaims(doc);
    expect(claims).toContain('Folder structure');
    expect(claims).toContain('Components are folder-per-component.');
    expect(claims).toContain('No cross-feature imports.');
    expect(claims).not.toContain('Some prose that is not a claim.');
  });
});

describe('extractRuleInventory', () => {
  test('collects eslint rules, armed checks, lint-meta ids, and doc claims across root + members', () => {
    const root = makeRepo();
    // Root eslint config + agent doc.
    writeFile(
      root,
      'eslint.config.mjs',
      `export default [{ rules: { 'nightcore/component-folder-structure': 'error' } }];`,
    );
    writeFile(
      root,
      'AGENTS.md',
      '# Guardrails\n- No cross-feature imports.\n',
    );
    // A member package with its own eslint config.
    writeFile(
      root,
      'apps/web/eslint.config.ts',
      `export default [{ rules: { 'react-hooks/exhaustive-deps': 'warn' } }];`,
    );
    // A lint-meta registry rule.
    writeFile(
      root,
      'tools/lint-meta/rules/agent-contract-parity.ts',
      `export const rule = { id: 'agent-contract-parity', run() {} };`,
    );
    // An armed Structure-Lock gauntlet check.
    writeFile(
      root,
      '.nightcore/harness.json',
      JSON.stringify({
        checks: [
          { name: 'component-folder-structure', kind: 'lint-plugin', command: 'x', enabled: true },
          { name: 'disabled-check', kind: 'lint-plugin', command: 'x', enabled: false },
        ],
      }),
    );

    const inv = extractRuleInventory(root, { packageDirs: ['apps/web'] });

    expect(inv.ruleIds).toContain('nightcore/component-folder-structure');
    expect(inv.ruleIds).toContain('react-hooks/exhaustive-deps'); // member config
    expect(inv.ruleIds).toContain('agent-contract-parity'); // lint-meta
    expect(inv.ruleIds).toContain('component-folder-structure'); // armed check
    expect(inv.ruleIds).not.toContain('disabled-check'); // enabled:false skipped
    expect(inv.count).toBe(inv.ruleIds.length);
    expect(inv.docClaims).toContain('No cross-feature imports.');
  });

  test('a repo with no enforcement tooling yields an empty inventory (never throws)', () => {
    const root = makeRepo();
    writeFile(root, 'package.json', '{"name":"bare"}');
    const inv = extractRuleInventory(root);
    expect(inv.ruleIds).toHaveLength(0);
    expect(inv.docClaims).toHaveLength(0);
    expect(inv.count).toBe(0);
  });

  test('a nonexistent project path degrades to empty, never throws', () => {
    const inv = extractRuleInventory('/no/such/path/at/all');
    expect(inv.count).toBe(0);
  });
});
