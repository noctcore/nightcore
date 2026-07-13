/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { Config, RepoProfile, SurfaceCommand } from '@nightcore/contracts';

import type {
  ScanRunnerFactory,
  ScanSessionRunner,
} from '../shared/scan-manager.js';
import { synthesizeHarness } from './synthesis.js';

/**
 * Orchestration coverage for {@link synthesizeHarness}: the ONE corrective retry it
 * mirrors from the base ScanManager. Prompt composition lives in `synthesis-prompt.ts`
 * (and its test), artifact/proposal grounding in `synthesis-artifacts.ts` /
 * `synthesis-parse.ts` (and their tests).
 */

const PROJECT = '/tmp/target-repo';

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
