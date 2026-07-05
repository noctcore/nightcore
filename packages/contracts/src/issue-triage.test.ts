/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  type SurfaceCommand,
  SurfaceCommandSchema,
} from './commands.js';
import {
  type NightcoreEvent,
  NightcoreEventSchema,
} from './events.js';
import {
  ISSUE_BODY_MAX_LEN,
  ISSUE_COMMENTS_MAX,
  ISSUE_PR_DIFF_MAX_LEN,
  IssueCommentSchema,
  IssueSummarySchema,
  type IssueValidationResult,
  IssueValidationResultSchema,
  IssueValidationSchema,
} from './issue-triage.js';

describe('IssueValidationResultSchema round-trips', () => {
  const valid: IssueValidationResult[] = [
    // A full bug verdict with a PR analysis.
    {
      issueKind: 'bug_report',
      verdict: 'valid',
      confidence: 'high',
      reasoning: 'The empty-project path renders before the guard.',
      bugConfirmed: true,
      relatedFiles: ['apps/web/src/App.tsx'],
      estimatedComplexity: 'simple',
      proposedPlan: '1. Guard the empty state.\n2. Render the projects view.',
      missingInfo: [],
      prAnalysis: {
        hasOpenPr: true,
        prNumber: 130,
        prFixesIssue: true,
        prSummary: 'PR #130 adds the missing guard.',
        recommendation: 'wait_for_merge',
      },
    },
    // A needs-clarification verdict: minimal, arrays fall to their defaults.
    {
      issueKind: 'question',
      verdict: 'needs_clarification',
      confidence: 'low',
      reasoning: 'The report lacks reproduction steps and an environment.',
      relatedFiles: [],
      missingInfo: ['Steps to reproduce', 'OS + app version'],
    },
    // A feature request with no PR analysis.
    {
      issueKind: 'feature_request',
      verdict: 'valid',
      confidence: 'medium',
      reasoning: 'A reasonable enhancement with a clear surface.',
      relatedFiles: [],
      estimatedComplexity: 'very_complex',
      missingInfo: [],
    },
  ];

  for (const [i, result] of valid.entries()) {
    test(`accepts and preserves verdict #${i} (${result.issueKind}/${result.verdict})`, () => {
      const parsed = IssueValidationResultSchema.parse(result);
      expect(parsed).toEqual(result);
    });
  }

  test('fills array fields from their defaults when omitted', () => {
    const parsed = IssueValidationResultSchema.parse({
      issueKind: 'unknown',
      verdict: 'invalid',
      confidence: 'low',
      reasoning: 'Not actionable.',
    });
    expect(parsed.relatedFiles).toEqual([]);
    expect(parsed.missingInfo).toEqual([]);
    expect(parsed.bugConfirmed).toBeUndefined();
    expect(parsed.prAnalysis).toBeUndefined();
  });
});

describe('IssueValidationResultSchema rejections', () => {
  const base = {
    issueKind: 'bug_report',
    verdict: 'valid',
    confidence: 'high',
    reasoning: 'ok',
  } as const;

  test('rejects an unknown issueKind', () => {
    expect(
      IssueValidationResultSchema.safeParse({ ...base, issueKind: 'incident' })
        .success,
    ).toBe(false);
  });

  test('rejects an unknown verdict', () => {
    expect(
      IssueValidationResultSchema.safeParse({ ...base, verdict: 'maybe' })
        .success,
    ).toBe(false);
  });

  test('rejects an unknown estimatedComplexity', () => {
    expect(
      IssueValidationResultSchema.safeParse({
        ...base,
        estimatedComplexity: 'epic',
      }).success,
    ).toBe(false);
  });

  test('rejects a prAnalysis with an unknown recommendation', () => {
    expect(
      IssueValidationResultSchema.safeParse({
        ...base,
        prAnalysis: { hasOpenPr: false, recommendation: 'close_it' },
      }).success,
    ).toBe(false);
  });

  test('rejects a prAnalysis missing its hasOpenPr flag', () => {
    expect(
      IssueValidationResultSchema.safeParse({
        ...base,
        prAnalysis: { recommendation: 'no_pr' },
      }).success,
    ).toBe(false);
  });
});

describe('IssueSummarySchema / IssueCommentSchema', () => {
  test('accepts a summary and defaults labels + linkedPrs to empty', () => {
    const parsed = IssueSummarySchema.parse({
      number: 7,
      title: 'Something broke',
      state: 'open',
      author: 'octocat',
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-02T10:00:00Z',
      commentCount: 0,
    });
    expect(parsed.labels).toEqual([]);
    expect(parsed.linkedPrs).toEqual([]);
  });

  test('preserves linked PRs including a merged state', () => {
    const parsed = IssueSummarySchema.parse({
      number: 7,
      title: 'Something broke',
      state: 'closed',
      labels: ['bug'],
      author: 'octocat',
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-02T10:00:00Z',
      commentCount: 2,
      linkedPrs: [{ number: 9, title: 'Fix it', state: 'merged' }],
    });
    expect(parsed.linkedPrs[0]).toEqual({
      number: 9,
      title: 'Fix it',
      state: 'merged',
    });
  });

  test('rejects a non-positive issue number', () => {
    expect(
      IssueSummarySchema.safeParse({
        number: 0,
        title: 't',
        state: 'open',
        author: 'a',
        createdAt: 'x',
        updatedAt: 'y',
        commentCount: 0,
      }).success,
    ).toBe(false);
  });

  test('accepts a comment and rejects one missing its body', () => {
    expect(
      IssueCommentSchema.parse({
        id: 'ic-1',
        author: 'maintainer',
        body: 'please attach a log',
        createdAt: '2026-07-01T10:00:00Z',
      }).id,
    ).toBe('ic-1');
    expect(
      IssueCommentSchema.safeParse({
        id: 'ic-1',
        author: 'maintainer',
        createdAt: '2026-07-01T10:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('IssueValidationSchema (stored record)', () => {
  test('round-trips a validation with an optional viewedAt', () => {
    const record = {
      issueNumber: 128,
      issueTitle: 'Crash when opening an empty project',
      validatedAt: '2026-07-04T12:00:00Z',
      model: 'claude-opus-4-8',
      result: {
        issueKind: 'bug_report',
        verdict: 'valid',
        confidence: 'high',
        reasoning: 'confirmed',
        relatedFiles: ['apps/web/src/App.tsx'],
        missingInfo: [],
      },
      viewedAt: '2026-07-04T12:05:00Z',
    };
    expect(IssueValidationSchema.parse(record)).toEqual(record);
  });
});

describe('SurfaceCommandSchema — issue-validation commands', () => {
  const valid: SurfaceCommand[] = [
    {
      type: 'start-issue-validation',
      runId: 'run-iv1',
      projectPath: '/proj',
      issueNumber: 128,
      issueTitle: 'Crash when opening an empty project',
      issueBody: 'white screen with no projects',
      issueAuthor: 'octocat',
      labels: ['bug'],
      comments: [
        {
          id: 'ic-1',
          author: 'maintainer',
          body: 'attach a log?',
          createdAt: '2026-07-01T10:00:00Z',
        },
      ],
      linkedPrs: [
        { number: 130, title: 'Guard the render path', state: 'open', diff: '@@ -1 +1 @@' },
      ],
      model: 'claude-opus-4-8',
      effort: 'high',
      maxTurns: 40,
      maxBudgetUsd: 2,
    },
    { type: 'cancel-issue-validation', runId: 'run-iv1' },
  ];

  for (const command of valid) {
    test(`accepts and preserves a ${command.type} command`, () => {
      expect(SurfaceCommandSchema.parse(command)).toEqual(command);
    });
  }

  test('defaults labels/comments/linkedPrs to empty arrays', () => {
    const parsed = SurfaceCommandSchema.parse({
      type: 'start-issue-validation',
      runId: 'run-iv2',
      projectPath: '/proj',
      issueNumber: 9,
      issueTitle: 't',
      issueBody: 'b',
      issueAuthor: 'a',
    });
    expect(parsed).toMatchObject({ labels: [], comments: [], linkedPrs: [] });
  });

  test('rejects a start-issue-validation without an issueNumber', () => {
    expect(
      SurfaceCommandSchema.safeParse({
        type: 'start-issue-validation',
        runId: 'run-iv1',
        projectPath: '/proj',
        issueTitle: 't',
        issueBody: 'b',
        issueAuthor: 'a',
      }).success,
    ).toBe(false);
  });

  test('rejects a comment payload with a non-string body', () => {
    expect(
      SurfaceCommandSchema.safeParse({
        type: 'start-issue-validation',
        runId: 'run-iv1',
        projectPath: '/proj',
        issueNumber: 9,
        issueTitle: 't',
        issueBody: 'b',
        issueAuthor: 'a',
        comments: [{ id: 'x', author: 'y', body: 3, createdAt: 'z' }],
      }).success,
    ).toBe(false);
  });

  test('enforces the untrusted-content size caps at the contract boundary', () => {
    const base = {
      type: 'start-issue-validation' as const,
      runId: 'run-iv-cap',
      projectPath: '/proj',
      issueNumber: 9,
      issueTitle: 't',
      issueBody: 'b',
      issueAuthor: 'a',
    };
    // A body exactly at the cap is accepted; one byte over is rejected — the cap is
    // structural, not prose-only, so a regression fails this test.
    expect(
      SurfaceCommandSchema.safeParse({
        ...base,
        issueBody: 'x'.repeat(ISSUE_BODY_MAX_LEN),
      }).success,
    ).toBe(true);
    expect(
      SurfaceCommandSchema.safeParse({
        ...base,
        issueBody: 'x'.repeat(ISSUE_BODY_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    // Too many comments is rejected (the aggregate array cap bounds the multiplied
    // untrusted surface independently of any Rust-side cap).
    const oneComment = {
      id: 'c',
      author: 'a',
      body: 'hi',
      createdAt: '2026-07-01T10:00:00Z',
    };
    expect(
      SurfaceCommandSchema.safeParse({
        ...base,
        comments: Array.from({ length: ISSUE_COMMENTS_MAX + 1 }, () => oneComment),
      }).success,
    ).toBe(false);
    // An oversized linked-PR diff is rejected.
    expect(
      SurfaceCommandSchema.safeParse({
        ...base,
        linkedPrs: [
          {
            number: 1,
            title: 'x',
            state: 'open',
            diff: 'd'.repeat(ISSUE_PR_DIFF_MAX_LEN + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('NightcoreEventSchema — issue-validation events', () => {
  const valid: NightcoreEvent[] = [
    {
      type: 'issue-validation-started',
      runId: 'run-iv1',
      issueNumber: 128,
      model: 'claude-opus-4-8',
    },
    {
      type: 'issue-validation-progress',
      runId: 'run-iv1',
      message: 'Investigating related files…',
    },
    {
      type: 'issue-validation-completed',
      runId: 'run-iv1',
      issueNumber: 128,
      result: {
        issueKind: 'bug_report',
        verdict: 'valid',
        confidence: 'high',
        reasoning: 'confirmed',
        relatedFiles: ['apps/web/src/App.tsx'],
        missingInfo: [],
      },
      costUsd: 0.06,
      durationMs: 8200,
    },
    // A completed event carrying the optional `usage` block plus a full prAnalysis,
    // so the whole spread `...runTotals` tail (costUsd + durationMs + usage) and the
    // nested result compose round-trip under the stronger `toEqual` assertion below.
    {
      type: 'issue-validation-completed',
      runId: 'run-iv2',
      issueNumber: 200,
      result: {
        issueKind: 'feature_request',
        verdict: 'valid',
        confidence: 'medium',
        reasoning: 'A reasonable enhancement.',
        relatedFiles: [],
        missingInfo: [],
        prAnalysis: {
          hasOpenPr: false,
          recommendation: 'no_pr',
        },
      },
      costUsd: 0.12,
      durationMs: 15000,
      usage: {
        inputTokens: 3000,
        outputTokens: 700,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
      },
    },
    {
      type: 'issue-validation-failed',
      runId: 'run-iv1',
      reason: 'aborted',
      message: 'cancelled by user',
    },
    {
      type: 'issue-validation-converted',
      runId: 'run-iv1',
      issueNumber: 128,
      taskId: 'task-42',
    },
  ];

  for (const [i, event] of valid.entries()) {
    // `toEqual(event)` is strictly stronger than `toMatchObject({ type })`: every
    // event here supplies all its fields (no default would mutate the value), so the
    // full payload — including the completed event's nested `result` + spread
    // `runTotals` (costUsd/durationMs/usage) — must survive the round-trip, not just
    // the discriminator.
    test(`accepts and preserves event #${i} (${event.type})`, () => {
      expect(NightcoreEventSchema.parse(event)).toEqual(event);
    });
  }

  test('rejects an issue-validation-completed carrying an invalid result', () => {
    expect(
      NightcoreEventSchema.safeParse({
        type: 'issue-validation-completed',
        runId: 'run-iv1',
        issueNumber: 128,
        result: { issueKind: 'bug_report' },
        costUsd: 0,
      }).success,
    ).toBe(false);
  });

  test('rejects an issue-validation-completed missing its costUsd run total', () => {
    // `costUsd` is required (no default) on the shared `runTotals` tail — the Rust
    // `IssueValidationCompleted` variant's `cost_usd: f64` is a required field, so a
    // payload omitting it must fail zod (and would fail serde) rather than silently
    // cross-tier drift.
    expect(
      NightcoreEventSchema.safeParse({
        type: 'issue-validation-completed',
        runId: 'run-iv1',
        issueNumber: 128,
        result: {
          issueKind: 'bug_report',
          verdict: 'valid',
          confidence: 'high',
          reasoning: 'confirmed',
        },
        durationMs: 8200,
      }).success,
    ).toBe(false);
  });

  test('rejects an issue-validation-completed with a negative durationMs', () => {
    // `durationMs` is `.nonnegative().default(0)`: absent → 0, but a present negative
    // value is rejected (it mirrors Rust `#[serde(default)] duration_ms: f64`).
    expect(
      NightcoreEventSchema.safeParse({
        type: 'issue-validation-completed',
        runId: 'run-iv1',
        issueNumber: 128,
        result: {
          issueKind: 'bug_report',
          verdict: 'valid',
          confidence: 'high',
          reasoning: 'confirmed',
        },
        costUsd: 0.06,
        durationMs: -1,
      }).success,
    ).toBe(false);
  });

  test('a completed event omitting durationMs + usage still round-trips (defaults applied)', () => {
    // The minimal run-totals shape: no `durationMs` (→ 0 default) and no `usage`
    // (→ omitted). This is the exact cross-tier shape the Rust serde `#[serde(default)]`
    // duration_ms + optional usage must accept (see the Rust conformance test).
    const parsed = NightcoreEventSchema.parse({
      type: 'issue-validation-completed',
      runId: 'run-iv3',
      issueNumber: 9,
      result: {
        issueKind: 'question',
        verdict: 'needs_clarification',
        confidence: 'low',
        reasoning: 'insufficient detail',
      },
      costUsd: 0,
    });
    if (parsed.type !== 'issue-validation-completed') throw new Error('unreachable');
    expect(parsed.durationMs).toBe(0);
    expect(parsed.usage).toBeUndefined();
    // The nested result's array fields also fall to their defaults.
    expect(parsed.result.relatedFiles).toEqual([]);
    expect(parsed.result.missingInfo).toEqual([]);
    expect(parsed.result.prAnalysis).toBeUndefined();
  });
});
