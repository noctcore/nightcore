import { expect, test } from 'vitest';

import type {
  IssueTriageEvent,
  IssueValidationResult,
  IssueValidationRun,
  StoredIssueValidationResult,
} from '@/lib/bridge';

import {
  EMPTY_ISSUE_TRIAGE_STREAM,
  foldIssueTriage,
  storedToVerdict,
  streamFromRun,
  wireToVerdict,
} from './issue-stream';

const WIRE_RESULT: IssueValidationResult = {
  issueKind: 'bug_report',
  verdict: 'valid',
  confidence: 'high',
  reasoning: 'Reproduced against the checkout.',
  bugConfirmed: true,
  relatedFiles: ['src/a.ts', 'src/b.ts'],
  estimatedComplexity: 'moderate',
  proposedPlan: '1. fix it',
  missingInfo: [],
  prAnalysis: {
    hasOpenPr: true,
    prNumber: 12,
    prFixesIssue: false,
    prSummary: 'The PR touches the area but misses the edge case.',
    recommendation: 'pr_needs_work',
  },
};

test('folds a started event into a running stream carrying the issue number', () => {
  const started: IssueTriageEvent = {
    type: 'issue-validation-started',
    runId: 'val-1',
    issueNumber: 7,
    model: 'claude-opus-4-8',
  };
  const next = foldIssueTriage(EMPTY_ISSUE_TRIAGE_STREAM, started);
  expect(next.status).toBe('running');
  expect(next.runId).toBe('val-1');
  expect(next.issueNumber).toBe(7);
  expect(next.model).toBe('claude-opus-4-8');
  expect(next.result).toBeNull();
});

test('folds a progress event into the live progress message', () => {
  const running = foldIssueTriage(EMPTY_ISSUE_TRIAGE_STREAM, {
    type: 'issue-validation-started',
    runId: 'val-1',
    issueNumber: 7,
    model: 'm',
  });
  const next = foldIssueTriage(running, {
    type: 'issue-validation-progress',
    runId: 'val-1',
    message: 'Investigating related files…',
  });
  expect(next.status).toBe('running');
  expect(next.progressMessage).toBe('Investigating related files…');
});

test('folds a completed event into the projected verdict + telemetry', () => {
  const running = foldIssueTriage(EMPTY_ISSUE_TRIAGE_STREAM, {
    type: 'issue-validation-started',
    runId: 'val-1',
    issueNumber: 7,
    model: 'm',
  });
  const next = foldIssueTriage(running, {
    type: 'issue-validation-completed',
    runId: 'val-1',
    issueNumber: 7,
    result: WIRE_RESULT,
    costUsd: 0.42,
    durationMs: 1234,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  expect(next.status).toBe('completed');
  expect(next.costUsd).toBe(0.42);
  expect(next.durationMs).toBe(1234);
  expect(next.result?.verdict).toBe('valid');
  expect(next.result?.relatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  expect(next.result?.prAnalysis?.recommendation).toBe('pr_needs_work');
});

test('folds a failed event, threading the reason so a cancel can be told from a crash', () => {
  const running = foldIssueTriage(EMPTY_ISSUE_TRIAGE_STREAM, {
    type: 'issue-validation-started',
    runId: 'val-1',
    issueNumber: 7,
    model: 'm',
  });
  const cancelled = foldIssueTriage(running, {
    type: 'issue-validation-failed',
    runId: 'val-1',
    reason: 'aborted',
    message: 'cancelled',
  });
  expect(cancelled.status).toBe('failed');
  expect(cancelled.failureReason).toBe('aborted');
  expect(cancelled.error).toBe('cancelled');
});

test('wireToVerdict fills optional fields with the view-safe null/empty defaults', () => {
  const minimal: IssueValidationResult = {
    issueKind: 'question',
    verdict: 'needs_clarification',
    confidence: 'low',
    reasoning: 'Unclear.',
    relatedFiles: [],
    missingInfo: ['repro steps'],
  };
  const view = wireToVerdict(minimal);
  expect(view.bugConfirmed).toBeNull();
  expect(view.estimatedComplexity).toBeNull();
  expect(view.proposedPlan).toBeNull();
  expect(view.prAnalysis).toBeNull();
  expect(view.missingInfo).toEqual(['repro steps']);
});

test('projects a persisted run into the stream with staleness + action markers', () => {
  const stored: StoredIssueValidationResult = {
    issueKind: 'bug_report',
    verdict: 'valid',
    confidence: 'high',
    reasoning: 'Reproduced.',
    bugConfirmed: true,
    relatedFiles: ['src/a.ts'],
    estimatedComplexity: 'moderate',
    proposedPlan: 'fix it',
    missingInfo: [],
    prAnalysis: null,
  };
  const run: IssueValidationRun = {
    id: 'val-9',
    projectPath: '/proj',
    issueNumber: 42,
    issueTitle: 'A bug',
    status: 'completed',
    model: 'claude-opus-4-8',
    createdAt: 1000,
    updatedAt: 2000,
    costUsd: 0.5,
    durationMs: 900,
    usage: { inputTokens: 3, outputTokens: 1 },
    result: stored,
    error: null,
    linkedTaskId: 'task-1',
    viewedAt: 1500,
    postedAt: 1800,
    postedCommentUrl: 'https://github.com/x/y/issues/42#issuecomment-1',
  };
  const stream = streamFromRun(run);
  expect(stream.runId).toBe('val-9');
  expect(stream.issueNumber).toBe(42);
  expect(stream.status).toBe('completed');
  expect(stream.validatedAt).toBe(2000);
  expect(stream.linkedTaskId).toBe('task-1');
  expect(stream.postedAt).toBe(1800);
  expect(stream.result?.verdict).toBe('valid');
  // The stored projector narrows the string-typed verdict to its union.
  expect(storedToVerdict(stored).issueKind).toBe('bug_report');
});
