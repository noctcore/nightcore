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
    // #18 ast-grep policy pack
    expect(ref).toContain('"kind": "ast-grep"');
    // #15 sandbox tier
    expect(ref).toContain('AGENT SANDBOX TIER');
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

describe('hardeningReference — ast-grep policy pack (#18)', () => {
  test('every stack gets the module with the runnable npx form and its check kind', () => {
    const ref = hardeningReference(profile({ workspaceTool: 'npm' }));
    expect(ref).toContain('sgconfig.yml');
    expect(ref).toContain('ast-grep-rules');
    expect(ref).toContain('"kind": "ast-grep"');
    // The empirically-verified command: bare `npx @ast-grep/cli` cannot resolve a bin
    // (the package ships two: ast-grep + sg), so the encoded form pins --package + the
    // ast-grep bin; `--error` escalates every rule and exits 1 on any match.
    expect(ref).toContain('npx --yes --package=@ast-grep/cli ast-grep scan --error');
  });

  test('a TypeScript repo gets the one live starter rule; other stacks stay grounded', () => {
    const ts = hardeningReference(profile());
    expect(ts).toContain('no-debugger');
    expect(ts).toContain('pattern: debugger');

    // ast-grep is tree-sitter based, so the module survives a non-node stack — but the
    // starter rule must be grounded in an observed pattern, never the TS example.
    const rust = hardeningReference(
      profile({ workspaceTool: 'cargo', languages: ['rust'] }),
    );
    expect(rust).toContain('sgconfig.yml');
    expect(rust).not.toContain('no-debugger');
    expect(rust).toContain('a pattern the findings actually name');
  });
});

describe('hardeningReference — api-extractor surface lock (#18)', () => {
  const libProfile = () =>
    profile({
      isMonorepo: true,
      workspaceTool: 'bun',
      packages: [
        { name: 'web', path: 'apps/web', role: 'app' },
        { name: 'contracts', path: 'packages/contracts', role: 'package' },
      ],
    });

  test('a TS library package gets the module grounded on the observed member path', () => {
    const ref = hardeningReference(libProfile());
    expect(ref).toContain('API SURFACE LOCK');
    expect(ref).toContain('packages/contracts/api-extractor.json');
    expect(ref).toContain('"kind": "api-extractor"');
    // Verified semantics: --local seeds/updates the committed report; the GATE form
    // omits it, so drift in the committed report is an error (non-zero exit).
    expect(ref).toContain(
      'npx --yes @microsoft/api-extractor run --local -c packages/contracts/api-extractor.json',
    );
    expect(ref).toContain(
      '"command": "npx --yes @microsoft/api-extractor run -c packages/contracts/api-extractor.json"',
    );
  });

  test('skipped without a package-role member or without typescript', () => {
    const appsOnly = hardeningReference(
      profile({
        isMonorepo: true,
        workspaceTool: 'bun',
        packages: [{ name: 'web', path: 'apps/web', role: 'app' }],
      }),
    );
    expect(appsOnly).not.toContain('API SURFACE LOCK');

    const rust = hardeningReference(
      profile({ workspaceTool: 'cargo', languages: ['rust'] }),
    );
    expect(rust).not.toContain('API SURFACE LOCK');
    expect(rust).not.toContain('api-extractor');
  });
});

describe('hardeningReference — agent sandbox tier (#15)', () => {
  test('the Seatbelt profile is the only artifact and carries the placeholder contract', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('sandbox/agent.sb');
    expect(ref).toContain('(deny file-write*)');
    expect(ref).toContain('__WORKSPACE_ROOT__');
    // Inert until a human explicitly loads it.
    expect(ref).toContain('sandbox-exec -f sandbox/agent.sb');
  });

  test('devcontainer + bubblewrap route agent-task ONLY (execution-adjacent)', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('.devcontainer/devcontainer.json');
    expect(ref).toContain('postCreateCommand');
    expect(ref).toContain('DENIES its basename');
    expect(ref).toContain('bwrap');
    expect(ref).toContain('shell script is execution-adjacent');
  });

  test('the tier claim stays honest about what containment fixes', () => {
    const ref = hardeningReference(profile());
    expect(ref).toContain('symlink');
    expect(ref).toContain('does not by itself contain network');
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
