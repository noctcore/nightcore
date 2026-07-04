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
        hasOpenPR: true,
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
        prAnalysis: { hasOpenPR: false, recommendation: 'close_it' },
      }).success,
    ).toBe(false);
  });

  test('rejects a prAnalysis missing its hasOpenPR flag', () => {
    expect(
      IssueValidationResultSchema.safeParse({
        ...base,
        prAnalysis: { recommendation: 'no_pr' },
      }).success,
    ).toBe(false);
  });
});

describe('IssueSummarySchema / IssueCommentSchema', () => {
  test('accepts a summary and defaults labels + linkedPRs to empty', () => {
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
    expect(parsed.linkedPRs).toEqual([]);
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
      linkedPRs: [{ number: 9, title: 'Fix it', state: 'merged' }],
    });
    expect(parsed.linkedPRs[0]).toEqual({
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

  for (const event of valid) {
    test(`accepts an ${event.type} event`, () => {
      const parsed = NightcoreEventSchema.parse(event);
      expect(parsed).toMatchObject({ type: event.type });
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
});
