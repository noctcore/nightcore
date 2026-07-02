/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Config, RepoProfile, SurfaceCommand } from '@nightcore/contracts';
import type {
  ScanRunnerFactory,
  ScanSessionRunner,
} from '../shared/scan-manager.js';
import {
  parseProposedArtifacts,
  parseSynthesis,
  synthesizeHarness,
} from './synthesis.js';

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

describe('synthesizeHarness — corrective retry', () => {
  const PROFILE = {
    isMonorepo: false,
    workspaceTool: 'single',
    packages: [],
    languages: ['typescript'],
    frameworks: [],
    hasEslintFlatConfig: false,
    hasLintMeta: false,
    hasAgentDocs: false,
    existingPlugins: [],
  } as unknown as RepoProfile;
  const COMMAND = {
    type: 'start-harness-scan',
    runId: 'run-1',
    projectPath: PROJECT,
    categories: [],
  } as unknown as Extract<SurfaceCommand, { type: 'start-harness-scan' }>;
  const CONFIG = {
    model: 'test-model',
    permissions: {},
    settingSources: [],
  } as unknown as Config;

  const VALID_ARTIFACTS = JSON.stringify([
    {
      kind: 'agent-contract',
      title: 'Codify conventions',
      description: 'Managed AGENTS.md section.',
      targetPath: 'AGENTS.md',
      writeMode: 'merge-section',
      content: '## Conventions\n- x',
    },
  ]);

  /** A fake runner factory: the first spin emits `first`, later spins emit `retry`.
   *  The reminder is detected off the prompt so the retry gets the valid output. */
  const factory = (first: string, retry: string, calls: { n: number }): ScanRunnerFactory =>
    (config, emit): ScanSessionRunner => ({
      async run() {
        calls.n += 1;
        const isRetry = config.prompt.includes('was not valid JSON');
        emit({
          type: 'session-completed',
          sessionId: -1,
          result: isRetry ? retry : first,
          costUsd: 0.1,
        } as never);
      },
      async interrupt() {},
    });

  test('re-asks once on unparseable output, then parses the retry', async () => {
    const calls = { n: 0 };
    const res = await synthesizeHarness({
      profile: PROFILE,
      findings: [],
      inventory: 'top-level: x',
      command: COMMAND,
      config: CONFIG,
      apiKeyFallback: false,
      runnerFactory: factory('not json at all', VALID_ARTIFACTS, calls),
    });
    expect(calls.n).toBe(2);
    expect(res.error).toBeUndefined();
    expect(res.artifacts).toHaveLength(1);
    // Cost accumulates across BOTH the first attempt and the retry.
    expect(res.costUsd).toBeCloseTo(0.2);
  });

  test('does not retry when the first result parses', async () => {
    const calls = { n: 0 };
    const res = await synthesizeHarness({
      profile: PROFILE,
      findings: [],
      inventory: 'top-level: x',
      command: COMMAND,
      config: CONFIG,
      apiKeyFallback: false,
      runnerFactory: factory(VALID_ARTIFACTS, VALID_ARTIFACTS, calls),
    });
    expect(calls.n).toBe(1);
    expect(res.artifacts).toHaveLength(1);
  });

  test('degrades to no proposals (with error) when the retry also fails', async () => {
    const calls = { n: 0 };
    const res = await synthesizeHarness({
      profile: PROFILE,
      findings: [],
      inventory: 'top-level: x',
      command: COMMAND,
      config: CONFIG,
      apiKeyFallback: false,
      runnerFactory: factory('still not json', 'also not json', calls),
    });
    expect(calls.n).toBe(2);
    expect(res.artifacts).toHaveLength(0);
    expect(res.error).toBeDefined();
  });
});

describe('synthesizeHarness — hardening playbook in the prompt', () => {
  const PROFILE = {
    isMonorepo: false,
    workspaceTool: 'npm',
    packages: [],
    languages: ['typescript'],
    frameworks: [],
    hasEslintFlatConfig: false,
    hasLintMeta: false,
    hasAgentDocs: false,
    existingPlugins: [],
  } as unknown as RepoProfile;
  const COMMAND = {
    type: 'start-harness-scan',
    runId: 'run-1',
    projectPath: PROJECT,
    categories: [],
  } as unknown as Extract<SurfaceCommand, { type: 'start-harness-scan' }>;
  const CONFIG = {
    model: 'test-model',
    permissions: {},
    settingSources: [],
  } as unknown as Config;

  test('the synthesis prompt carries the hardening modules and the tool-config kind', async () => {
    let prompt = '';
    const factory: ScanRunnerFactory = (config, emit): ScanSessionRunner => ({
      async run() {
        prompt = config.prompt;
        emit({
          type: 'session-completed',
          sessionId: -1,
          result: '{"artifacts":[],"proposals":[]}',
          costUsd: 0,
        } as never);
      },
      async interrupt() {},
    });
    await synthesizeHarness({
      profile: PROFILE,
      findings: [],
      inventory: 'top-level: x',
      command: COMMAND,
      config: CONFIG,
      apiKeyFallback: false,
      runnerFactory: factory,
    });
    // The profile-conditional playbook (reference.ts) is injected…
    expect(prompt).toContain('HARDENING MODULES');
    expect(prompt).toContain('.gitleaks.toml');
    // …and the artifact contract advertises the tool-config kind so the model can
    // actually emit what the playbook asks for.
    expect(prompt).toContain('custom-lint-plugin|tool-config');
    expect(prompt).toContain('`tool-config` is a standalone hardening config file');
  });
});

describe('parseSynthesis — task-shaped proposals', () => {
  /** A single valid artifact whose engine-assigned id we reuse in proposals. */
  const ARTIFACT = {
    kind: 'agent-contract',
    title: 'Codify conventions',
    description: 'Managed AGENTS.md section.',
    targetPath: 'AGENTS.md',
    writeMode: 'merge-section',
    content: '## Conventions\n- x',
  };
  // The id the engine deterministically assigns this artifact (`kind-fingerprint`).
  const ARTIFACT_ID = parseProposedArtifacts(
    JSON.stringify([ARTIFACT]),
    PROJECT,
  ).artifacts[0]!.id;

  test('parses artifacts AND proposals from the object envelope', () => {
    const raw = JSON.stringify({
      artifacts: [ARTIFACT],
      proposals: [
        {
          kind: 'apply-artifacts',
          title: 'Adopt the agent contract',
          description: 'Write the AGENTS.md guardrail section.',
          artifactIds: [ARTIFACT_ID],
        },
        {
          kind: 'agent-task',
          title: 'Wire the plugin into eslint.config.ts',
          description: 'Register the generated plugin and enable its rules.',
          prompt: 'Add the plugin to eslint.config.ts and enable the rule as error.',
          verifyCommand: 'npx eslint .',
          harnessCheck: {
            name: 'component-folder-structure',
            kind: 'lint-plugin',
            command: 'npx eslint .',
          },
        },
      ],
    });
    const { artifacts, proposals, error } = parseSynthesis(raw, PROJECT);
    expect(error).toBeUndefined();
    expect(artifacts).toHaveLength(1);
    expect(proposals).toHaveLength(2);

    const apply = proposals.find((p) => p.kind === 'apply-artifacts');
    expect(apply?.artifactIds).toEqual([ARTIFACT_ID]);

    const agent = proposals.find((p) => p.kind === 'agent-task');
    expect(agent?.prompt).toContain('eslint.config.ts');
    expect(agent?.verifyCommand).toBe('npx eslint .');
    expect(agent?.harnessCheck?.command).toBe('npx eslint .');
    // Every proposal carries a stable, distinct fingerprint + id.
    expect(new Set(proposals.map((p) => p.fingerprint)).size).toBe(2);
  });

  test('drops an apply-artifacts proposal that references no surviving artifact', () => {
    const raw = JSON.stringify({
      artifacts: [ARTIFACT],
      proposals: [
        {
          kind: 'apply-artifacts',
          title: 'dangling',
          description: 'references an artifact that was never proposed',
          artifactIds: ['eslint-rule-deadbeefdeadbeef'],
        },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT);
    expect(proposals).toHaveLength(0);
  });

  test('drops an agent-task proposal with no prompt', () => {
    const raw = JSON.stringify({
      artifacts: [],
      proposals: [
        { kind: 'agent-task', title: 'no prompt', description: 'x' },
        { kind: 'agent-task', title: 'blank prompt', description: 'x', prompt: '   ' },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT);
    expect(proposals).toHaveLength(0);
  });

  test('drops a partial harnessCheck but keeps the proposal', () => {
    const raw = JSON.stringify({
      artifacts: [],
      proposals: [
        {
          kind: 'agent-task',
          title: 'wire it',
          description: 'x',
          prompt: 'do the wiring',
          harnessCheck: { name: 'x', kind: 'lint-plugin' }, // no command → dropped
        },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.harnessCheck).toBeUndefined();
  });

  test('a bare artifacts array yields artifacts and zero proposals (back-compat)', () => {
    const { artifacts, proposals, error } = parseSynthesis(
      JSON.stringify([ARTIFACT]),
      PROJECT,
    );
    expect(error).toBeUndefined();
    expect(artifacts).toHaveLength(1);
    expect(proposals).toHaveLength(0);
  });
});

describe('parseSynthesis — tool-config artifacts + hardening checks', () => {
  /** A valid `.gitleaks.toml` tool-config artifact (module #4a's shape). */
  const GITLEAKS = {
    kind: 'tool-config',
    title: 'Secret-scan starter config',
    description: 'Gitleaks config extending the default ruleset with a project allowlist.',
    targetPath: '.gitleaks.toml',
    writeMode: 'create',
    content: 'title = "gitleaks"\n[extend]\nuseDefault = true\n',
    language: 'toml',
  };
  const GITLEAKS_ID = parseProposedArtifacts(JSON.stringify([GITLEAKS]), PROJECT)
    .artifacts[0]!.id;

  test('a tool-config artifact + its secret-scan harnessCheck round-trip', () => {
    const raw = JSON.stringify({
      artifacts: [GITLEAKS],
      proposals: [
        {
          kind: 'apply-artifacts',
          title: 'Adopt secret scanning',
          description: 'Write the gitleaks starter config.',
          artifactIds: [GITLEAKS_ID],
          harnessCheck: {
            name: 'secret-scan',
            kind: 'secret-scan',
            command: 'gitleaks detect --no-banner --redact',
          },
        },
      ],
    });
    const { artifacts, proposals, error } = parseSynthesis(raw, PROJECT);
    expect(error).toBeUndefined();
    expect(artifacts[0]?.kind).toBe('tool-config');
    expect(artifacts[0]?.targetPath).toBe('.gitleaks.toml');
    expect(proposals[0]?.harnessCheck?.kind).toBe('secret-scan');
  });

  test('every hardening harnessCheck kind passes through (kind is a wire string)', () => {
    // The contract keeps `harnessCheck.kind` a bare string precisely so new gauntlet
    // kinds never break deserialize; the armable-kind allowlist lives in Rust at arm
    // time. All four producer kinds must survive the engine parse untouched.
    for (const kind of ['lockfile-lint', 'env-contract', 'secret-scan', 'mutation-score']) {
      const raw = JSON.stringify({
        artifacts: [],
        proposals: [
          {
            kind: 'agent-task',
            title: `wire ${kind}`,
            description: 'x',
            prompt: 'do the wiring',
            harnessCheck: { name: kind, kind, command: 'run-the-check' },
          },
        ],
      });
      const { proposals } = parseSynthesis(raw, PROJECT);
      expect(proposals[0]?.harnessCheck?.kind, `kind ${kind} must survive`).toBe(kind);
    }
  });

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
