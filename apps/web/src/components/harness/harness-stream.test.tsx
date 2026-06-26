import { describe, expect, it } from 'vitest';
import type {
  ConventionFinding,
  HarnessRun,
  HarnessScanEvent,
  ProposedArtifact,
  RepoProfile,
  StoredConventionFinding,
  StoredProposedArtifact,
  StoredRepoProfile,
} from '@/lib/bridge';
import {
  EMPTY_HARNESS_STREAM,
  foldHarness,
  storedToArtifact,
  storedToConventionFinding,
  storedToProfile,
  streamFromRun,
  wireToArtifact,
  wireToConventionFinding,
  type HarnessStream,
} from './harness-stream';

function wireFinding(over: Partial<ConventionFinding> = {}): ConventionFinding {
  return {
    id: 'c1',
    category: 'folder-structure',
    kind: 'convention',
    severity: 'high',
    title: 'Folder-per-component',
    description: 'Each component ships its sibling set.',
    evidence: [],
    tags: [],
    fingerprint: 'fp1',
    ...over,
  };
}

function wireArtifact(over: Partial<ProposedArtifact> = {}): ProposedArtifact {
  return {
    id: 'a1',
    kind: 'eslint-rule',
    title: 'component-folder-structure',
    description: 'Enforce the sibling set.',
    targetPath: 'packages/eslint-plugin/src/rules/component-folder-structure.ts',
    writeMode: 'create',
    content: 'export const rule = {};',
    sourceFindings: ['fp1'],
    dependsOn: [],
    fingerprint: 'afp1',
    ...over,
  };
}

function wireProfile(over: Partial<RepoProfile> = {}): RepoProfile {
  return {
    isMonorepo: true,
    workspaceTool: 'bun',
    packages: [{ name: '@nightcore/web', path: 'apps/web', role: 'app' }],
    languages: ['typescript', 'rust'],
    frameworks: ['react', 'tauri'],
    hasEslintFlatConfig: true,
    hasLintMeta: true,
    hasAgentDocs: true,
    existingPlugins: ['@nightcore/eslint-plugin'],
    ...over,
  };
}

const USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

describe('foldHarness', () => {
  it('harness-scan-started resets to a running stream with pending categories', () => {
    const next = foldHarness(EMPTY_HARNESS_STREAM, {
      type: 'harness-scan-started',
      runId: 'run-1',
      categories: ['folder-structure', 'naming'],
      model: 'claude-opus-4-8',
    } as HarnessScanEvent);
    expect(next.runId).toBe('run-1');
    expect(next.status).toBe('running');
    expect(next.requestedCategories).toEqual(['folder-structure', 'naming']);
    expect(next.categoryState).toEqual({
      'folder-structure': 'pending',
      naming: 'pending',
    });
  });

  it('harness-profile-ready sets the detected profile', () => {
    const next = foldHarness(
      { ...EMPTY_HARNESS_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'harness-profile-ready',
        runId: 'run-1',
        profile: wireProfile(),
      } as HarnessScanEvent,
    );
    expect(next.profile?.isMonorepo).toBe(true);
    expect(next.profile?.workspaceTool).toBe('bun');
    expect(next.profile?.frameworks).toEqual(['react', 'tauri']);
  });

  it('category-started marks that lens running', () => {
    const start = foldHarness(EMPTY_HARNESS_STREAM, {
      type: 'harness-scan-started',
      runId: 'run-1',
      categories: ['folder-structure'],
      model: 'm',
    } as HarnessScanEvent);
    const next = foldHarness(start, {
      type: 'harness-category-started',
      runId: 'run-1',
      category: 'folder-structure',
    } as HarnessScanEvent);
    expect(next.categoryState['folder-structure']).toBe('running');
  });

  it('category-completed appends grounded findings and accumulates cost/usage', () => {
    const base: HarnessStream = {
      ...EMPTY_HARNESS_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['folder-structure'],
      categoryState: { 'folder-structure': 'running' },
    };
    const next = foldHarness(base, {
      type: 'harness-category-completed',
      runId: 'run-1',
      category: 'folder-structure',
      findings: [wireFinding()],
      usage: USAGE,
      costUsd: 0.04,
    } as HarnessScanEvent);
    expect(next.findings).toHaveLength(1);
    expect(next.findings[0]?.status).toBe('open');
    expect(next.findings[0]?.kind).toBe('convention');
    expect(next.categoryState['folder-structure']).toBe('done');
    expect(next.costUsd).toBeCloseTo(0.04);
    expect(next.usage.inputTokens).toBe(100);
  });

  it('category-completed with an error marks the lens errored', () => {
    const base: HarnessStream = {
      ...EMPTY_HARNESS_STREAM,
      runId: 'run-1',
      status: 'running',
      categoryState: { naming: 'running' },
    };
    const next = foldHarness(base, {
      type: 'harness-category-completed',
      runId: 'run-1',
      category: 'naming',
      findings: [],
      costUsd: 0,
      error: 'no JSON',
    } as HarnessScanEvent);
    expect(next.categoryState.naming).toBe('error');
  });

  it('a re-emitted lens replaces only that lens’s findings', () => {
    let s: HarnessStream = {
      ...EMPTY_HARNESS_STREAM,
      runId: 'run-1',
      status: 'running',
    };
    s = foldHarness(s, {
      type: 'harness-category-completed',
      runId: 'run-1',
      category: 'folder-structure',
      findings: [wireFinding({ id: 'fs1', fingerprint: 'fs1' })],
      costUsd: 0,
    } as HarnessScanEvent);
    s = foldHarness(s, {
      type: 'harness-category-completed',
      runId: 'run-1',
      category: 'naming',
      findings: [wireFinding({ id: 'n1', category: 'naming', fingerprint: 'n1' })],
      costUsd: 0,
    } as HarnessScanEvent);
    expect(s.findings.map((f) => f.id).sort()).toEqual(['fs1', 'n1']);
  });

  it('synthesis-started flips the synthesizing flag (the post-lens dead-zone)', () => {
    const next = foldHarness(
      { ...EMPTY_HARNESS_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'harness-synthesis-started',
        runId: 'run-1',
      } as HarnessScanEvent,
    );
    expect(next.synthesizing).toBe(true);
    expect(next.status).toBe('running');
  });

  it('proposals-ready sets the proposed artifacts and clears synthesizing', () => {
    const next = foldHarness(
      { ...EMPTY_HARNESS_STREAM, runId: 'run-1', status: 'running', synthesizing: true },
      {
        type: 'harness-proposals-ready',
        runId: 'run-1',
        artifacts: [wireArtifact()],
      } as HarnessScanEvent,
    );
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifacts[0]?.status).toBe('proposed');
    expect(next.artifacts[0]?.appliedPath).toBeNull();
    expect(next.synthesizing).toBe(false);
  });

  it('terminal events clear synthesizing', () => {
    const base: HarnessStream = {
      ...EMPTY_HARNESS_STREAM,
      runId: 'run-1',
      status: 'running',
      synthesizing: true,
    };
    const completed = foldHarness(base, {
      type: 'harness-scan-completed',
      runId: 'run-1',
      profile: wireProfile(),
      findings: [],
      artifacts: [],
      categoriesRun: [],
      costUsd: 0,
      durationMs: 1,
      usage: USAGE,
    } as HarnessScanEvent);
    expect(completed.synthesizing).toBe(false);
    const failed = foldHarness(base, {
      type: 'harness-scan-failed',
      runId: 'run-1',
      reason: 'aborted',
      message: 'cancelled',
    } as HarnessScanEvent);
    expect(failed.synthesizing).toBe(false);
  });

  it('scan-completed sets the final findings, artifacts + totals and marks all done', () => {
    const base: HarnessStream = {
      ...EMPTY_HARNESS_STREAM,
      runId: 'run-1',
      status: 'running',
      requestedCategories: ['folder-structure', 'naming'],
      categoryState: { 'folder-structure': 'done', naming: 'error' },
    };
    const next = foldHarness(base, {
      type: 'harness-scan-completed',
      runId: 'run-1',
      profile: wireProfile(),
      findings: [wireFinding()],
      artifacts: [wireArtifact()],
      categoriesRun: ['folder-structure', 'naming'],
      costUsd: 0.12,
      durationMs: 45000,
      usage: USAGE,
    } as HarnessScanEvent);
    expect(next.status).toBe('completed');
    expect(next.findings).toHaveLength(1);
    expect(next.artifacts).toHaveLength(1);
    expect(next.profile?.isMonorepo).toBe(true);
    expect(next.durationMs).toBe(45000);
    // An errored lens stays errored; others become done.
    expect(next.categoryState.naming).toBe('error');
    expect(next.categoryState['folder-structure']).toBe('done');
  });

  it('scan-failed records the error and carries the failure reason', () => {
    const next = foldHarness(
      { ...EMPTY_HARNESS_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'harness-scan-failed',
        runId: 'run-1',
        reason: 'aborted',
        message: 'cancelled',
      } as HarnessScanEvent,
    );
    expect(next.status).toBe('failed');
    expect(next.error).toBe('cancelled');
    // The reason lets RESULTS show a neutral "cancelled" notice for a user abort.
    expect(next.failureReason).toBe('aborted');
  });

  it('scan-failed carries a non-abort reason for the red failure banner', () => {
    const next = foldHarness(
      { ...EMPTY_HARNESS_STREAM, runId: 'run-1', status: 'running' },
      {
        type: 'harness-scan-failed',
        runId: 'run-1',
        reason: 'runner-crash',
        message: 'sidecar died',
      } as HarnessScanEvent,
    );
    expect(next.failureReason).toBe('runner-crash');
  });
});

describe('normalizers', () => {
  it('wireToConventionFinding maps a contract finding to the open view shape', () => {
    const f = wireToConventionFinding(
      wireFinding({
        evidence: [{ file: 'src/a.ts', startLine: 10 }],
        suggestion: 'Codify it as an ESLint rule.',
      }),
    );
    expect(f.status).toBe('open');
    expect(f.evidence[0]?.file).toBe('src/a.ts');
    expect(f.evidence[0]?.startLine).toBe(10);
    expect(f.evidence[0]?.endLine).toBeNull();
    expect(f.suggestion).toBe('Codify it as an ESLint rule.');
  });

  it('storedToConventionFinding narrows the persisted string fields to unions', () => {
    const stored: StoredConventionFinding = {
      id: 'c1',
      category: 'imports-boundaries',
      kind: 'gap',
      severity: 'critical',
      title: 't',
      description: 'd',
      rationale: null,
      evidence: [],
      suggestion: null,
      tags: [],
      confidence: null,
      fingerprint: 'fp',
      status: 'dismissed',
    };
    const f = storedToConventionFinding(stored);
    expect(f.category).toBe('imports-boundaries');
    expect(f.kind).toBe('gap');
    expect(f.status).toBe('dismissed');
  });

  it('wireToArtifact maps a contract artifact to the proposed view shape', () => {
    const a = wireToArtifact(wireArtifact({ group: 'eslint-plugin' }));
    expect(a.status).toBe('proposed');
    expect(a.group).toBe('eslint-plugin');
    expect(a.appliedPath).toBeNull();
    expect(a.appliedAt).toBeNull();
  });

  it('storedToArtifact carries the applied lifecycle', () => {
    const stored: StoredProposedArtifact = {
      id: 'a1',
      kind: 'agent-contract',
      group: null,
      groupTitle: null,
      title: 't',
      description: 'd',
      rationale: null,
      targetPath: 'CLAUDE.md',
      writeMode: 'merge-section',
      content: '## rules',
      language: 'markdown',
      sourceFindings: [],
      dependsOn: [],
      confidence: null,
      fingerprint: 'afp',
      status: 'applied',
      appliedPath: 'CLAUDE.md',
      appliedAt: 1234,
    };
    const a = storedToArtifact(stored);
    expect(a.kind).toBe('agent-contract');
    expect(a.writeMode).toBe('merge-section');
    expect(a.status).toBe('applied');
    expect(a.appliedPath).toBe('CLAUDE.md');
  });

  it('storedToProfile narrows the persisted enum strings', () => {
    const stored: StoredRepoProfile = {
      isMonorepo: false,
      workspaceTool: 'single',
      packages: [{ name: 'app', path: '.', role: 'app' }],
      languages: ['typescript'],
      frameworks: [],
      hasEslintFlatConfig: false,
      hasLintMeta: false,
      hasAgentDocs: false,
      existingPlugins: [],
    };
    const p = storedToProfile(stored);
    expect(p.isMonorepo).toBe(false);
    expect(p.workspaceTool).toBe('single');
    expect(p.packages[0]?.role).toBe('app');
  });

  it('streamFromRun projects a completed persisted run into the stream shape', () => {
    const run: HarnessRun = {
      id: 'run-1',
      projectPath: '/proj',
      status: 'completed',
      categories: ['folder-structure'],
      model: 'm',
      createdAt: 1,
      updatedAt: 2,
      costUsd: 0.5,
      durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 5 },
      profile: {
        isMonorepo: true,
        workspaceTool: 'bun',
        packages: [],
        languages: ['typescript'],
        frameworks: ['react'],
        hasEslintFlatConfig: true,
        hasLintMeta: true,
        hasAgentDocs: true,
        existingPlugins: [],
      },
      findings: [],
      artifacts: [],
      error: null,
    };
    const s = streamFromRun(run);
    expect(s.status).toBe('completed');
    expect(s.categoryState['folder-structure']).toBe('done');
    expect(s.profile?.workspaceTool).toBe('bun');
    expect(s.costUsd).toBe(0.5);
    // The persisted run carries neither the synthesis tail nor the failure reason.
    expect(s.synthesizing).toBe(false);
    expect(s.failureReason).toBeNull();
  });
});
