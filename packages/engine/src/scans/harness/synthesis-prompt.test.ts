/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type {
  ConventionFinding,
  RepoProfile,
  SurfaceCommand,
} from '@nightcore/contracts';

import { buildSynthesisPrompt, summarizeProfile } from './synthesis-prompt.js';

/**
 * Prompt-composition coverage: the synthesis user prompt must carry the profile-
 * conditional hardening playbook, advertise the artifact/tool-config output contract,
 * and state the Drift-v1 (T15) compiled-check contract with its convention fingerprints.
 */

const PROJECT = '/tmp/target-repo';

const COMMAND = {
  type: 'start-harness-scan',
  runId: 'run-1',
  projectPath: PROJECT,
  categories: [],
} as unknown as Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

describe('summarizeProfile', () => {
  test('renders the deterministically-detected profile fields', () => {
    const profile = {
      isMonorepo: true,
      workspaceTool: 'bun',
      packages: [{ name: '@nightcore/engine', role: 'lib', path: 'packages/engine' }],
      languages: ['typescript'],
      frameworks: ['react'],
      hasEslintFlatConfig: true,
      hasLintMeta: true,
      hasAgentDocs: false,
      existingPlugins: ['@noctcore/eslint-plugin-engine'],
    } as unknown as RepoProfile;

    const summary = summarizeProfile(profile);
    expect(summary).toContain('monorepo: true (workspace tool: bun)');
    expect(summary).toContain('@nightcore/engine [lib] (packages/engine)');
    expect(summary).toContain('lint-meta engine: true');
    expect(summary).toContain('existing eslint plugins: @noctcore/eslint-plugin-engine');
  });

  test('renders empty collections with their placeholders', () => {
    const profile = {
      isMonorepo: false,
      workspaceTool: 'single',
      packages: [],
      languages: [],
      frameworks: [],
      hasEslintFlatConfig: false,
      hasLintMeta: false,
      hasAgentDocs: false,
      existingPlugins: [],
    } as unknown as RepoProfile;

    const summary = summarizeProfile(profile);
    expect(summary).toContain('packages: none');
    expect(summary).toContain('languages: unknown');
    expect(summary).toContain('frameworks: none detected');
    expect(summary).toContain('existing eslint plugins: none');
  });
});

describe('buildSynthesisPrompt — hardening playbook + output contract', () => {
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

  test('the synthesis prompt carries the hardening modules and the tool-config kind', () => {
    const prompt = buildSynthesisPrompt(PROFILE, [], 'top-level: x', COMMAND);
    // The profile-conditional playbook (reference.ts) is injected…
    expect(prompt).toContain('HARDENING MODULES');
    expect(prompt).toContain('.gitleaks.toml');
    // …and the artifact contract advertises the tool-config kind so the model can
    // actually emit what the playbook asks for.
    expect(prompt).toContain('custom-lint-plugin|tool-config');
    expect(prompt).toContain('`tool-config` is a standalone hardening config file');
  });
});

describe('buildSynthesisPrompt — drift-compile contract (T15)', () => {
  const STRUCTURAL_FP = 'a1b2c3d4e5f60718';

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
  ] as unknown as ConventionFinding[];

  test('the synthesis prompt advertises the drift-compile contract', () => {
    const PROFILE = {
      isMonorepo: true,
      workspaceTool: 'bun',
      packages: [],
      languages: ['typescript'],
      frameworks: [],
      hasEslintFlatConfig: true,
      hasLintMeta: true,
      hasAgentDocs: false,
      existingPlugins: [],
    } as unknown as RepoProfile;

    const prompt = buildSynthesisPrompt(PROFILE, FINDINGS, 'top-level: x', COMMAND);
    expect(prompt).toContain('COMPILE DRIFT CHECKS');
    expect(prompt).toContain('conventionFingerprint');
    // The v0.3 substrate boundary is stated (lint-meta + shell, not eslint/ast-grep).
    expect(prompt).toContain('kind:"lint-meta"');
    expect(prompt).toContain('kind:"shell"');
    // The convention fingerprints are printed so the model can cite them.
    expect(prompt).toContain(STRUCTURAL_FP);
  });
});
