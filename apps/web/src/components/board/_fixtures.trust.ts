import type { TrustReport } from '@/lib/bridge';

import { STRUCTURE_LOCK_FAILED, STRUCTURE_LOCK_PASSED } from './_fixtures.gauntlet';

/** Build a TrustReport fixture for stories/tests. Mirrors the canonical
 *  `workflow/trust/contract.rs` shape; overrides deep-merge the section objects so
 *  a test can tweak just one nested field. */
export function makeTrustReport(overrides: Partial<TrustReport> = {}): TrustReport {
  return {
    taskId: overrides.taskId ?? 'task-1',
    title: overrides.title ?? 'Wire up auth guard',
    status: overrides.status ?? 'done',
    runMode: overrides.runMode ?? 'worktree',
    branch: overrides.branch ?? 'nc/auth-guard',
    baseBranch: overrides.baseBranch ?? 'main',
    prUrl: overrides.prUrl,
    prNumber: overrides.prNumber,
    generatedAt: overrides.generatedAt ?? '2026-07-10T18:30:00Z',
    gauntlet: {
      verified: true,
      verdict: 'VERDICT: PASS — the diff matches the task and the tests cover it.',
      review:
        'The change adds the auth middleware and wires it into the router.\n\nVERDICT: PASS — the diff matches the task and the tests cover it.',
      fixAttempts: 0,
      structureLock: STRUCTURE_LOCK_PASSED,
      ...overrides.gauntlet,
    },
    guardrails: {
      toolsEvaluated: 42,
      allowed: 40,
      asked: 1,
      denied: 1,
      blocked: [
        {
          tool: 'Bash',
          ruleId: 'sandbox-protected-path',
          digest: 'rm -rf ~/.ssh',
          ts: '2026-07-10T18:12:03Z',
          decision: 'deny',
        },
      ],
      askedEvents: [
        {
          tool: 'Write',
          ruleId: undefined,
          digest: 'apps/web/src/lib/auth/guard.ts',
          ts: '2026-07-10T18:09:44Z',
          decision: 'ask',
        },
      ],
      policyHold: undefined,
      scopePark: undefined,
      ...overrides.guardrails,
    },
    flight: {
      sessionCount: 3,
      filesTouched: ['apps/web/src/lib/auth/guard.ts', 'apps/web/src/router.ts'],
      filesTouchedCount: 2,
      commands: ['bun test auth', 'bun run typecheck'],
      commandsCount: 2,
      costUsdLastRun: 0.42,
      costUsdTotal: 0.86,
      tokens: {
        input: 128_400,
        output: 18_220,
        reasoningOutput: 9_100,
        cacheRead: 512_000,
        cacheCreation: 44_000,
      },
      ...overrides.flight,
    },
    quarantine: overrides.quarantine ?? [],
  };
}

/** A clean, fully verified receipt — reviewer PASS, structure-lock green, a couple
 *  of guardrail events, cost + tokens present. The demoable happy path. */
export const TRUST_VERIFIED: TrustReport = makeTrustReport();

/** A receipt whose gauntlet FAILED at a structure-lock check and whose reviewer
 *  requested changes — the "do not trust this merge yet" shape. */
export const TRUST_GAUNTLET_FAILED: TrustReport = makeTrustReport({
  gauntlet: {
    verified: false,
    verdict: 'VERDICT: CHANGES REQUESTED — the new component is not in its own folder.',
    review:
      'The folder-per-component convention is violated.\n\nVERDICT: CHANGES REQUESTED — the new component is not in its own folder.',
    fixAttempts: 2,
    structureLock: STRUCTURE_LOCK_FAILED,
  },
});

/** A receipt with denied + asked guardrail actions AND a policy hold — exercises the
 *  guardrail section's full history rendering. */
export const TRUST_DENIALS: TrustReport = makeTrustReport({
  guardrails: {
    toolsEvaluated: 57,
    allowed: 52,
    asked: 2,
    denied: 3,
    blocked: [
      {
        tool: 'Bash',
        ruleId: 'sandbox-protected-path',
        digest: 'cat ~/.aws/credentials',
        ts: '2026-07-10T18:12:03Z',
        decision: 'deny',
      },
      {
        tool: 'Write',
        ruleId: 'harness-protected-path',
        digest: '.nightcore/harness.json',
        ts: '2026-07-10T18:14:20Z',
        decision: 'deny',
      },
    ],
    askedEvents: [
      {
        tool: 'Bash',
        ruleId: undefined,
        digest: 'git push --force origin nc/auth-guard',
        ts: '2026-07-10T18:20:10Z',
        decision: 'ask',
      },
    ],
    policyHold: 'A protected path was denied — a harness-managed file cannot be overwritten.',
    scopePark: undefined,
  },
});

/** An EMPTY receipt — a task that has run no sessions and produced no gauntlet,
 *  guardrail, or flight signal yet. The band must render its quiet empty state
 *  rather than a wall of zeroes with no meaning. */
export const TRUST_EMPTY: TrustReport = makeTrustReport({
  taskId: 'task-empty',
  title: 'Draft the settings store',
  status: 'in_progress',
  gauntlet: {
    verified: false,
    verdict: undefined,
    review: undefined,
    fixAttempts: 0,
    structureLock: undefined,
  },
  guardrails: {
    toolsEvaluated: 0,
    allowed: 0,
    asked: 0,
    denied: 0,
    blocked: [],
    askedEvents: [],
    policyHold: undefined,
    scopePark: undefined,
  },
  flight: {
    sessionCount: 0,
    filesTouched: [],
    filesTouchedCount: 0,
    commands: [],
    commandsCount: 0,
    costUsdLastRun: undefined,
    costUsdTotal: undefined,
    tokens: undefined,
  },
});
