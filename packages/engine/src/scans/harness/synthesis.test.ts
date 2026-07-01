/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseProposedArtifacts } from './synthesis.js';

/**
 * Focused coverage for the synthesis parse/ground helper — specifically the new
 * `custom-lint-plugin` artifact kind and the multi-file ESLint-plugin bundle it
 * heads. `coerceArtifact` validates kinds via `ArtifactKindSchema`, so an
 * unknown kind is dropped while the new literal survives, shares its `group`,
 * and keeps its `dependsOn` ordering — without changing the one-file write path.
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
