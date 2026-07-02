/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { RepoProfile } from '@nightcore/contracts';
import { hardeningReference } from './reference.js';

/**
 * Coverage for the hardening-catalog producer guidance. These tests pin the SECURITY
 * ROUTING of each module — which shape (tool-config artifact vs agent-task proposal)
 * the prompt steers the model toward — and the profile-conditional honesty rules:
 * per-package-manager lockfile commands (never lockfile-lint for a format it can't
 * parse), no `.npmrc` pitch for bun, the fabrication guard on characterization tests,
 * and the never-write-policy rule for install interception. A regression here means
 * the synthesis prompt asks the model for output the Rust apply path would reject (or
 * worse, for claims the profile can't support).
 */

function profile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    isMonorepo: false,
    workspaceTool: 'single',
    packages: [],
    languages: ['typescript'],
    frameworks: [],
    hasEslintFlatConfig: false,
    hasLintMeta: false,
    hasAgentDocs: false,
    existingPlugins: [],
    ...overrides,
  };
}

describe('hardeningReference — module coverage', () => {
  test('a node repo gets every module with its harnessCheck kind', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'npm' }));
    // #4 secret hygiene
    expect(ref).toContain('.gitleaks.toml');
    expect(ref).toContain('gitleaks detect --no-banner --redact');
    expect(ref).toContain('"kind": "secret-scan"');
    // #7 import-boundary lock
    expect(ref).toContain('.dependency-cruiser.cjs');
    expect(ref).toContain('"kind": "dependency-cruiser"');
    // #10 changed-lines coverage gate
    expect(ref).toContain('diff-cover coverage/coverage.xml --fail-under=80');
    expect(ref).toContain('"kind": "coverage-threshold"');
    // #11 dependency firewall
    expect(ref).toContain('"kind": "lockfile-lint"');
    // #13 env contract
    expect(ref).toContain('env.schema.ts');
    expect(ref).toContain('"kind": "env-contract"');
    // #16 characterization tests
    expect(ref).toContain('CHARACTERIZATION TESTS');
    // #17 mutation audit
    expect(ref).toContain('npx stryker run');
    expect(ref).toContain('"kind": "mutation-score"');
    // #18 commit discipline
    expect(ref).toContain('COMMIT DISCIPLINE');
  });

  test('the routing header names both shapes and the apply-path denial', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('tool-config');
    expect(ref).toContain('agent-task');
    // The reason execution-adjacent work must not be an artifact.
    expect(ref).toContain('REJECTS');
    // create-mode honesty: never target an existing file.
    expect(ref).toContain('refuses to overwrite');
  });

  test('a non-node stack skips the JS-only modules but keeps the universal ones', () => {
    const ref = hardeningReference(
      profile({ workspaceTool: 'cargo', languages: ['rust'], isMonorepo: true }),
    );
    expect(ref).not.toContain('.dependency-cruiser.cjs');
    expect(ref).not.toContain('env.schema.ts');
    expect(ref).not.toContain('stryker');
    expect(ref).not.toContain('.npmrc');
    // Universal modules survive: secrets, diff coverage, characterization, commits.
    expect(ref).toContain('.gitleaks.toml');
    expect(ref).toContain('diff-cover');
    expect(ref).toContain('CHARACTERIZATION TESTS');
    expect(ref).toContain('COMMIT DISCIPLINE');
    expect(ref).toContain('JS-only modules');
  });
});

describe('hardeningReference — dependency firewall per package manager', () => {
  test('npm: .npmrc artifact + lockfile-lint over package-lock.json', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'npm' }));
    expect(ref).toContain('ignore-scripts=true');
    expect(ref).toContain('save-exact=true');
    expect(ref).toContain(
      'npx lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm',
    );
  });

  test('pnpm: .npmrc artifact but a frozen-lockfile check (lockfile-lint cannot parse it)', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'pnpm', isMonorepo: true }));
    expect(ref).toContain('ignore-scripts=true');
    expect(ref).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(ref).not.toContain('lockfile-lint --path pnpm');
  });

  test('bun: no .npmrc pitch (lifecycle scripts are opt-in) + bun frozen-lockfile check', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'bun', isMonorepo: true }));
    expect(ref).not.toContain('ignore-scripts=true');
    expect(ref).toContain('trustedDependencies');
    expect(ref).toContain('bun install --frozen-lockfile');
  });

  test('yarn: .yarnrc.yml routes via agent-task (the file usually exists) + yarn lockfile-lint', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'yarn', isMonorepo: true }));
    expect(ref).toContain('.yarnrc.yml');
    expect(ref).toContain(
      'npx lockfile-lint --path yarn.lock --type yarn --validate-https --allowed-hosts npm yarn',
    );
    expect(ref).not.toContain('ignore-scripts=true');
  });

  test('unknown package manager: the per-lockfile table instead of a guess', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'turbo', isMonorepo: true }));
    expect(ref).toContain('package-lock.json →');
    expect(ref).toContain('yarn.lock →');
    expect(ref).toContain('pnpm-lock.yaml →');
    expect(ref).toContain('bun.lock →');
  });

  test('install interception stays a described policy pattern, never proposal-authored', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'npm' }));
    expect(ref).toContain('policy.denyBashPatterns');
    expect(ref).toContain('proposals NEVER');
    expect(ref).toContain('proposal DESCRIPTION');
    // The copy-pasteable example pattern, JSON-escaped as it would sit in harness.json.
    expect(ref).toContain('\\\\b(npm|pnpm|yarn|bun)\\\\s+(add|install)\\\\b');
  });
});

describe('hardeningReference — import boundaries derived from the profile', () => {
  test('an observed apps/packages layering emits a LIVE boundary rule + real roots', () => {
    const ref = hardeningReference(
      profile({
        isMonorepo: true,
        workspaceTool: 'bun',
        packages: [
          { name: 'web', path: 'apps/web', role: 'app' },
          { name: 'contracts', path: 'packages/contracts', role: 'package' },
        ],
      }),
    );
    expect(ref).toContain('packages-not-into-apps');
    expect(ref).toContain('npx depcruise apps packages');
    // The observed rule is active, not the commented placeholder.
    expect(ref).not.toContain('// add layer rules');
  });

  test('with no observed layering the boundary rule stays a commented example', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'npm' }));
    expect(ref).toContain('// add layer rules ONLY for boundaries you observed');
    expect(ref).toContain('npx depcruise src');
    expect(ref).not.toContain('packages-not-into-apps');
  });
});

describe('hardeningReference — fabrication guards', () => {
  test('characterization tests require named, grounded candidates or a full skip', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('SKIP this module entirely');
    expect(ref).toContain('never fabricate');
  });

  test('commit discipline is agent-task ONLY (lefthook config is execution-adjacent)', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('agent-task ONLY, never artifacts');
    expect(ref).toContain('lefthook.yml');
  });

  test('the env schema demands only variables actually seen read in code', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'bun' }));
    expect(ref).toContain('ONLY variables you saw read');
    expect(ref).toContain('"command": "bun run env:check"');
  });
});
