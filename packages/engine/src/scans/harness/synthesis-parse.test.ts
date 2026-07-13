/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { ConventionFinding } from '@nightcore/contracts';

import { parseProposedArtifacts } from './synthesis-artifacts.js';
import { conventionFingerprintSet, parseSynthesis } from './synthesis-parse.js';

/**
 * Parse coverage for the full synthesis answer: the object envelope
 * `{ artifacts, proposals }`, proposal grounding against surviving artifacts, hardening
 * `harnessCheck` pass-through, and Drift-v1 (T15) fingerprint grounding. `parseProposedArtifacts`
 * (artifact grounding) is imported only to derive the engine-assigned artifact ids the
 * proposals reference.
 */

const PROJECT = '/tmp/target-repo';

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
    for (const kind of [
      'lockfile-lint',
      'env-contract',
      'secret-scan',
      'mutation-score',
      'ast-grep',
      'api-extractor',
    ]) {
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
});

/**
 * Drift-v1 (T15) compiled-check grounding. Synthesis compiles a
 * mechanically-checkable convention into a `harnessCheck` (a lint-meta rule or a
 * shell/ripgrep count) that carries the convention's `conventionFingerprint`, so a
 * later EnforceRun can attribute site counts back to a `ConventionDrift` record. The
 * fingerprint is GROUNDED against the run's real CONVENTION findings: a value that
 * matches no convention (a `gap`, an unknown, or an injected string) is dropped, and
 * a non-checkable convention simply gets no check.
 */
describe('synthesis — drift check compiler (T15)', () => {
  const STRUCTURAL_FP = 'a1b2c3d4e5f60718'; // a folder-structure convention
  const TEXTUAL_FP = '1122334455667788'; // a naming/textual convention
  const GAP_FP = '99aa99aa99aa99aa'; // a gap — drift is never measured on gaps

  const FINDINGS = [
    {
      id: 'folder-structure-a1b2c3d4e5f60718',
      category: 'folder-structure',
      kind: 'convention',
      severity: 'medium',
      title: 'Components live in a folder-per-component',
      description: 'Each component has its own directory.',
      evidence: [],
      tags: [],
      fingerprint: STRUCTURAL_FP,
    },
    {
      id: 'naming-1122334455667788',
      category: 'naming',
      kind: 'convention',
      severity: 'low',
      title: 'Hooks are prefixed with use',
      description: 'Custom hooks start with `use`.',
      evidence: [],
      tags: [],
      fingerprint: TEXTUAL_FP,
    },
    {
      id: 'testing-99aa99aa99aa99aa',
      category: 'testing',
      kind: 'gap',
      severity: 'high',
      title: 'No coverage threshold is enforced',
      description: 'Tests run without a floor.',
      evidence: [],
      tags: [],
      fingerprint: GAP_FP,
    },
  ] as unknown as ConventionFinding[];

  test('conventionFingerprintSet keeps convention fingerprints and drops gaps', () => {
    const set = conventionFingerprintSet(FINDINGS);
    expect(set.has(STRUCTURAL_FP)).toBe(true);
    expect(set.has(TEXTUAL_FP)).toBe(true);
    // A `gap` is a missing practice — you cannot measure drift against it.
    expect(set.has(GAP_FP)).toBe(false);
    expect(set.size).toBe(2);
  });

  test('grounds a compiled lint-meta check and a shell check on their conventions', () => {
    const RULE_ARTIFACT = {
      kind: 'lint-meta-rule',
      title: 'folder-per-component rule',
      description: 'Fails when a component file is not in its own folder.',
      targetPath: 'tools/lint-meta/rules/folder-per-component.ts',
      writeMode: 'create',
      content: 'export const rule = {};\n',
      sourceFindings: [STRUCTURAL_FP],
    };
    const ruleId = parseProposedArtifacts(
      JSON.stringify([RULE_ARTIFACT]),
      PROJECT,
    ).artifacts[0]!.id;

    const raw = JSON.stringify({
      artifacts: [RULE_ARTIFACT],
      proposals: [
        {
          // STRUCTURAL → lint-meta rule, shipped via apply-artifacts.
          kind: 'apply-artifacts',
          title: 'Arm the folder-per-component drift check',
          description: 'Apply the rule and arm it.',
          artifactIds: [ruleId],
          harnessCheck: {
            name: 'folder-per-component',
            kind: 'lint-meta',
            command: 'bun run lint:meta',
            conventionFingerprint: STRUCTURAL_FP,
          },
        },
        {
          // TEXTUAL → shell/ripgrep count, on an agent-task (no artifact to write).
          kind: 'agent-task',
          title: 'Arm the hook-prefix drift check',
          description: 'Count hooks that break the use-prefix convention.',
          prompt: 'Review and arm the shell drift check.',
          harnessCheck: {
            name: 'hook-use-prefix',
            kind: 'shell',
            command: "rg -c '^export function [a-z]' src/hooks",
            conventionFingerprint: TEXTUAL_FP,
          },
        },
      ],
    });

    const set = conventionFingerprintSet(FINDINGS);
    const { proposals } = parseSynthesis(raw, PROJECT, set);
    expect(proposals).toHaveLength(2);

    const lintMeta = proposals.find((p) => p.harnessCheck?.kind === 'lint-meta');
    expect(lintMeta?.harnessCheck?.conventionFingerprint).toBe(STRUCTURAL_FP);

    const shell = proposals.find((p) => p.harnessCheck?.kind === 'shell');
    expect(shell?.harnessCheck?.command).toContain('rg -c');
    expect(shell?.harnessCheck?.conventionFingerprint).toBe(TEXTUAL_FP);
  });

  test('drops a fingerprint that cites a gap or an unknown convention', () => {
    const raw = JSON.stringify({
      artifacts: [],
      proposals: [
        {
          kind: 'agent-task',
          title: 'gap-cited check',
          description: 'x',
          prompt: 'arm it',
          harnessCheck: {
            name: 'gap-check',
            kind: 'shell',
            command: 'rg -c TODO src',
            conventionFingerprint: GAP_FP, // a gap is not in the grounded set
          },
        },
        {
          kind: 'agent-task',
          title: 'unknown-cited check',
          description: 'x',
          prompt: 'arm it',
          harnessCheck: {
            name: 'ghost-check',
            kind: 'shell',
            command: 'rg -c XXX src',
            conventionFingerprint: 'deadbeefdeadbeef', // matches no finding
          },
        },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT, conventionFingerprintSet(FINDINGS));
    // Both proposals survive (they are valid agent-tasks), but the ungrounded
    // fingerprint is stripped — the check is no longer drift-linked.
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.harnessCheck?.conventionFingerprint).toBeUndefined();
    }
  });

  test('a non-checkable convention emits no compiled check', () => {
    // The model judged this convention un-mechanizable, so it attached no
    // harnessCheck — the proposal carries no drift link.
    const raw = JSON.stringify({
      artifacts: [],
      proposals: [
        {
          kind: 'agent-task',
          title: 'Document the design decision',
          description: 'A convention that needs human judgement to verify.',
          prompt: 'Explain the layering decision in AGENTS.md.',
        },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT, conventionFingerprintSet(FINDINGS));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.harnessCheck).toBeUndefined();
  });

  test('without a grounding set no check is drift-linked (safe default)', () => {
    // An isolated caller passes no set: a cited fingerprint can never be verified,
    // so it is dropped rather than trusted from raw model output.
    const raw = JSON.stringify({
      artifacts: [],
      proposals: [
        {
          kind: 'agent-task',
          title: 'ungrounded',
          description: 'x',
          prompt: 'arm it',
          harnessCheck: {
            name: 'c',
            kind: 'shell',
            command: 'rg -c x src',
            conventionFingerprint: STRUCTURAL_FP,
          },
        },
      ],
    });
    const { proposals } = parseSynthesis(raw, PROJECT);
    expect(proposals[0]?.harnessCheck?.conventionFingerprint).toBeUndefined();
  });
});
