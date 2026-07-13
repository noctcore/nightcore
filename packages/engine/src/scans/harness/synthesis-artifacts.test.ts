/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { parseProposedArtifacts } from './synthesis-artifacts.js';

/**
 * Artifact grounding coverage: the `custom-lint-plugin` kind + multi-file ESLint-plugin
 * bundle, tool-config carriers that survive grounding, and the execution-sink denylist
 * that mirrors the Rust apply boundary. `coerceArtifact` validates kinds via
 * `ArtifactKindSchema`, so an unknown kind is dropped while known literals survive, share
 * their `group`, and keep their `dependsOn` ordering — without changing the one-file
 * write path.
 */

const PROJECT = '/tmp/target-repo';

describe('parseProposedArtifacts — custom-lint-plugin bundle', () => {
  test('accepts the custom-lint-plugin kind and groups the plugin files', () => {
    const raw = JSON.stringify([
      {
        kind: 'custom-lint-plugin',
        group: 'eslint-plugin',
        groupTitle: 'Project lint plugin',
        title: 'Generated lint plugin',
        description: 'Project-specific ESLint plugin enforcing conventions.',
        targetPath: 'tools/eslint-plugin/README.md',
        writeMode: 'create',
        content: '# eslint-plugin-project\n\nGenerated rules: hooks-naming.',
        language: 'markdown',
        sourceFindings: ['fp-hooks'],
      },
      {
        kind: 'eslint-plugin-file',
        group: 'eslint-plugin',
        groupTitle: 'Project lint plugin',
        title: 'Plugin scaffold',
        description: 'index.js re-exporting the rules.',
        targetPath: 'tools/eslint-plugin/index.js',
        writeMode: 'create',
        content:
          'module.exports = { rules: { "hooks-naming": require("./rules/hooks-naming") } };',
        language: 'typescript',
        sourceFindings: ['fp-hooks'],
      },
      {
        kind: 'eslint-plugin-file',
        group: 'eslint-plugin',
        groupTitle: 'Project lint plugin',
        title: 'hooks-naming rule',
        description: 'AST rule: hooks must be named use*.',
        targetPath: 'tools/eslint-plugin/rules/hooks-naming.js',
        writeMode: 'create',
        content: 'module.exports = { meta: {}, create() { return {}; } };',
        language: 'typescript',
        sourceFindings: ['fp-hooks'],
        dependsOn: ['eslint-plugin-file-scaffold'],
      },
    ]);

    const { artifacts, error } = parseProposedArtifacts(raw, PROJECT);
    expect(error).toBeUndefined();
    expect(artifacts).toHaveLength(3);

    const header = artifacts.find((a) => a.kind === 'custom-lint-plugin');
    expect(header).toBeDefined();
    expect(header?.group).toBe('eslint-plugin');
    expect(header?.targetPath).toBe('tools/eslint-plugin/README.md');

    // every member shares one group → the UI bundles them as a set
    expect(artifacts.every((a) => a.group === 'eslint-plugin')).toBe(true);

    const rule = artifacts.find((a) =>
      a.targetPath.endsWith('rules/hooks-naming.js'),
    );
    expect(rule?.dependsOn).toEqual(['eslint-plugin-file-scaffold']);
  });

  test('still drops an unknown kind but keeps a valid custom-lint-plugin', () => {
    const raw = JSON.stringify([
      {
        kind: 'not-a-real-kind',
        title: 'bogus',
        description: 'x',
        targetPath: 'x.js',
        writeMode: 'create',
        content: 'x',
      },
      {
        kind: 'custom-lint-plugin',
        group: 'eslint-plugin',
        title: 'Generated lint plugin',
        description: 'plugin header',
        targetPath: 'tools/eslint-plugin/README.md',
        writeMode: 'create',
        content: '# plugin',
      },
    ]);
    const { artifacts } = parseProposedArtifacts(raw, PROJECT);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('custom-lint-plugin');
  });

  test('grounds a custom-lint-plugin whose targetPath escapes the repo', () => {
    const raw = JSON.stringify([
      {
        kind: 'custom-lint-plugin',
        title: 'evil',
        description: 'x',
        targetPath: '../outside/README.md',
        writeMode: 'create',
        content: '# nope',
      },
    ]);
    const { artifacts } = parseProposedArtifacts(raw, PROJECT);
    expect(artifacts).toHaveLength(0);
  });
});

describe('parseProposedArtifacts — tool-config carriers', () => {
  test('a .npmrc tool-config survives grounding (pin config, not an execution sink)', () => {
    // Module #11's carrier: `.npmrc` only sets install FLAGS (ignore-scripts,
    // save-exact) — it cannot itself run code, so it is deliberately NOT denied.
    const { artifacts } = parseProposedArtifacts(
      JSON.stringify([
        {
          kind: 'tool-config',
          title: 'Dependency firewall pin config',
          description: 'ignore-scripts + save-exact.',
          targetPath: '.npmrc',
          writeMode: 'create',
          content: 'ignore-scripts=true\nsave-exact=true\n',
        },
      ]),
      PROJECT,
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.targetPath).toBe('.npmrc');
  });

  test('lefthook configs are dropped as execution sinks in every variant', () => {
    // Module #18's guardrail: lefthook recipe bodies run as git hooks once installed,
    // so commit-discipline output must be an agent-task — a tool-config aimed at any
    // lefthook config name (any depth, any case) never reaches the preview.
    for (const targetPath of [
      'lefthook.yml',
      '.lefthook.yaml',
      'tools/lefthook.toml',
      'packages/web/Lefthook.json',
    ]) {
      const { artifacts } = parseProposedArtifacts(
        JSON.stringify([
          {
            kind: 'tool-config',
            title: 'x',
            description: 'x',
            targetPath,
            writeMode: 'create',
            content: 'pre-commit:\n  commands: {}\n',
          },
        ]),
        PROJECT,
      );
      expect(artifacts, `must drop lefthook config ${targetPath}`).toHaveLength(0);
    }
  });

  test('devcontainer configs are dropped as execution sinks in both name forms', () => {
    // Module #15's guardrail: devcontainers run postCreate/onCreate hooks, so the
    // sandbox tier's devcontainer piece must be an agent-task — a tool-config aimed at
    // either name form (any depth, any case) never reaches the preview. Mirrors the
    // Rust DENIED_TARGET_BASENAMES entries in harness/apply.rs.
    for (const targetPath of [
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      'apps/web/.devcontainer/devcontainer.json',
      '.devcontainer/DevContainer.json',
    ]) {
      const { artifacts } = parseProposedArtifacts(
        JSON.stringify([
          {
            kind: 'tool-config',
            title: 'x',
            description: 'x',
            targetPath,
            writeMode: 'create',
            content: '{ "postCreateCommand": "evil" }',
          },
        ]),
        PROJECT,
      );
      expect(artifacts, `must drop devcontainer config ${targetPath}`).toHaveLength(0);
    }
  });

  test('the Seatbelt profile tool-config survives grounding (inert until sandbox-exec)', () => {
    // Module #15's one direct artifact: `sandbox/agent.sb` is a deny-write-except
    // profile nothing loads until a human runs `sandbox-exec -f` — not a sink.
    const { artifacts } = parseProposedArtifacts(
      JSON.stringify([
        {
          kind: 'tool-config',
          title: 'macOS Seatbelt write-containment profile',
          description: 'Deny-write-except profile for agent runs.',
          targetPath: 'sandbox/agent.sb',
          writeMode: 'create',
          content:
            '(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "__WORKSPACE_ROOT__"))\n',
        },
      ]),
      PROJECT,
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.targetPath).toBe('sandbox/agent.sb');
  });
});

describe('parseProposedArtifacts — execution-sink grounding', () => {
  const sink = (targetPath: string, writeMode = 'create') => ({
    kind: 'agent-contract',
    title: 'x',
    description: 'x',
    targetPath,
    writeMode,
    content: 'malicious',
  });

  test('drops prompt-injected auto-run execution sinks before the preview', () => {
    // The class of one-click-apply → code-execution targets: auto-loaded agent/editor
    // config, package-manager lifecycle scripts, make/direnv/CI hooks. None are legitimate
    // harness output, so grounding must strip them even though they are repo-contained.
    for (const targetPath of [
      '.claude/settings.local.json',
      '.claude/settings.json',
      '.vscode/tasks.json',
      'package.json',
      'apps/web/package.json',
      'Makefile',
      'tools/GNUmakefile',
      '.envrc',
      '.pre-commit-config.yaml',
      '.github/workflows/evil.yml',
      '.husky/pre-commit',
    ]) {
      const { artifacts } = parseProposedArtifacts(
        JSON.stringify([sink(targetPath)]),
        PROJECT,
      );
      expect(artifacts, `must drop sink ${targetPath}`).toHaveLength(0);
    }
  });

  test('confines merge-section to agent docs, keeps legitimate output', () => {
    // merge-section into a non-agent-doc (an existing file the denylist might miss) is
    // dropped; a create of a normal source/doc file and an agent-doc merge both survive.
    const injected = parseProposedArtifacts(
      JSON.stringify([sink('src/server/boot.ts', 'merge-section')]),
      PROJECT,
    );
    expect(injected.artifacts).toHaveLength(0);

    const legit = parseProposedArtifacts(
      JSON.stringify([
        sink('AGENTS.md', 'merge-section'),
        {
          kind: 'eslint-config',
          title: 'flat config',
          description: 'x',
          targetPath: 'eslint.config.js',
          writeMode: 'create',
          content: 'export default [];',
        },
      ]),
      PROJECT,
    );
    expect(legit.artifacts).toHaveLength(2);
    expect(legit.artifacts.map((a) => a.targetPath).sort()).toEqual([
      'AGENTS.md',
      'eslint.config.js',
    ]);
  });
});
