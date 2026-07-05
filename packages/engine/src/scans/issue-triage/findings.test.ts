/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { IssueValidationResult } from '@nightcore/contracts';

import { groundIssueVerdict, parseIssueVerdict } from './findings.js';

/** A full, well-formed verdict object the model is asked to emit. */
const FULL_VERDICT = {
  issueKind: 'bug_report',
  verdict: 'valid',
  confidence: 'high',
  reasoning: 'The empty-project guard renders after the crash path.',
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
};

describe('parseIssueVerdict — the strict single-object contract', () => {
  test('parses one clean verdict object', () => {
    const { verdict, error } = parseIssueVerdict(JSON.stringify(FULL_VERDICT));
    expect(error).toBeUndefined();
    expect(verdict?.verdict).toBe('valid');
    expect(verdict?.issueKind).toBe('bug_report');
    expect(verdict?.confidence).toBe('high');
    expect(verdict?.bugConfirmed).toBe(true);
    expect(verdict?.relatedFiles).toEqual(['apps/web/src/App.tsx']);
    expect(verdict?.prAnalysis?.recommendation).toBe('wait_for_merge');
  });

  test('tolerates a one-element array wrapper (the scorecard tolerance)', () => {
    const { verdict, error } = parseIssueVerdict(
      JSON.stringify([FULL_VERDICT]),
    );
    expect(error).toBeUndefined();
    expect(verdict?.verdict).toBe('valid');
  });

  test('tolerates a ```json fenced object with surrounding prose', () => {
    const raw = `Here is my verdict:\n\`\`\`json\n${JSON.stringify(
      FULL_VERDICT,
    )}\n\`\`\`\nDone.`;
    const { verdict, error } = parseIssueVerdict(raw);
    expect(error).toBeUndefined();
    expect(verdict?.issueKind).toBe('bug_report');
  });

  test('returns an error when there is no JSON at all (⇒ corrective retry)', () => {
    const { verdict, error } = parseIssueVerdict('I could not find anything.');
    expect(verdict).toBeUndefined();
    expect(error).toBeDefined();
  });

  test('errors on an off-contract verdict value (must not be fabricated)', () => {
    const { verdict, error } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, verdict: 'maybe' }),
    );
    expect(verdict).toBeUndefined();
    expect(error).toContain('verdict');
  });

  test('errors when reasoning is missing/empty (the other non-fabricatable field)', () => {
    const { verdict, error } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, reasoning: '   ' }),
    );
    expect(verdict).toBeUndefined();
    expect(error).toBeDefined();
  });

  test('coerces an unrecognized issueKind to the honest "unknown" (never errors)', () => {
    const { verdict } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, issueKind: 'incident', prAnalysis: undefined }),
    );
    expect(verdict?.issueKind).toBe('unknown');
  });

  test('maps common kind synonyms (bug → bug_report, feature → feature_request)', () => {
    expect(
      parseIssueVerdict(JSON.stringify({ ...FULL_VERDICT, issueKind: 'bug' }))
        .verdict?.issueKind,
    ).toBe('bug_report');
    expect(
      parseIssueVerdict(
        JSON.stringify({ ...FULL_VERDICT, issueKind: 'feature' }),
      ).verdict?.issueKind,
    ).toBe('feature_request');
  });

  test('coerces a missing/odd confidence to "low" rather than losing the verdict', () => {
    const { verdict } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, confidence: 'unsure' }),
    );
    expect(verdict?.confidence).toBe('low');
  });

  test('drops an off-scale estimatedComplexity (optional, never faked)', () => {
    const { verdict } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, estimatedComplexity: 'epic' }),
    );
    expect(verdict?.estimatedComplexity).toBeUndefined();
    expect(verdict?.verdict).toBe('valid');
  });

  test('derives an off-contract PR recommendation from the authoritative hasOpenPr', () => {
    const withOpenPr = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        prAnalysis: { hasOpenPr: true, recommendation: 'close_it' },
      }),
    ).verdict;
    expect(withOpenPr?.prAnalysis?.recommendation).toBe('pr_needs_work');

    // `hasOpenPr: false` but a localized `prNumber` ⇒ a PR was reasoned about, so the
    // analysis is retained and the off-contract recommendation is derived to `no_pr`.
    const noPr = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        prAnalysis: { hasOpenPr: false, prNumber: 55, recommendation: 'nonsense' },
      }),
    ).verdict;
    expect(noPr?.prAnalysis?.recommendation).toBe('no_pr');
    expect(noPr?.prAnalysis?.prNumber).toBe(55);
  });

  test('drops a contentless prAnalysis (no open PR, no prNumber) — no phantom section', () => {
    // A stray `{ hasOpenPr: false }` with no PR to reason about must not surface a
    // spurious `no_pr` analysis (the contract scopes prAnalysis to "only when a linked
    // PR was provided"). The rest of the verdict is unaffected.
    const { verdict } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, prAnalysis: { hasOpenPr: false } }),
    );
    expect(verdict?.prAnalysis).toBeUndefined();
    expect(verdict?.verdict).toBe('valid');

    // The same for a bare empty object.
    expect(
      parseIssueVerdict(
        JSON.stringify({ ...FULL_VERDICT, prAnalysis: {} }),
      ).verdict?.prAnalysis,
    ).toBeUndefined();
  });

  test('drops a malformed prAnalysis but keeps the rest of the verdict', () => {
    const { verdict } = parseIssueVerdict(
      JSON.stringify({ ...FULL_VERDICT, prAnalysis: 'not an object' }),
    );
    expect(verdict?.prAnalysis).toBeUndefined();
    expect(verdict?.verdict).toBe('valid');
  });

  test('normalizes relatedFiles paths (strips ./, drops empties) at parse time', () => {
    const { verdict } = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        relatedFiles: ['./apps/web/src/App.tsx', '', 'src/a.ts'],
      }),
    );
    expect(verdict?.relatedFiles).toEqual(['apps/web/src/App.tsx', 'src/a.ts']);
  });

  test('parses a needs_clarification verdict, preserving its missingInfo checklist', () => {
    const { verdict, error } = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        issueKind: 'question',
        verdict: 'needs_clarification',
        missingInfo: ['Steps to reproduce', 'OS + app version'],
        prAnalysis: undefined,
      }),
    );
    expect(error).toBeUndefined();
    expect(verdict?.verdict).toBe('needs_clarification');
    expect(verdict?.missingInfo).toEqual(['Steps to reproduce', 'OS + app version']);
  });

  test('errors on a needs_clarification verdict with an empty missingInfo (⇒ retry)', () => {
    // The contract requires a populated missingInfo on this verdict; an empty list is
    // off-contract, so it must error (triggering the single corrective retry) rather
    // than emit a signal-free "needs clarification".
    const { verdict, error } = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        verdict: 'needs_clarification',
        missingInfo: [],
        prAnalysis: undefined,
      }),
    );
    expect(verdict).toBeUndefined();
    expect(error).toContain('missingInfo');
  });

  test('maps verdict synonyms (needs_info/unclear/incomplete → needs_clarification)', () => {
    for (const synonym of ['needs_info', 'unclear', 'incomplete']) {
      expect(
        parseIssueVerdict(
          JSON.stringify({
            ...FULL_VERDICT,
            verdict: synonym,
            missingInfo: ['what is missing'],
            prAnalysis: undefined,
          }),
        ).verdict?.verdict,
      ).toBe('needs_clarification');
    }
  });

  test('maps confidence synonym "med" → "medium"', () => {
    expect(
      parseIssueVerdict(JSON.stringify({ ...FULL_VERDICT, confidence: 'med' }))
        .verdict?.confidence,
    ).toBe('medium');
  });

  test('maps extra kind synonyms (enhancement → feature_request, defect → bug_report, support → question)', () => {
    expect(
      parseIssueVerdict(
        JSON.stringify({ ...FULL_VERDICT, issueKind: 'enhancement' }),
      ).verdict?.issueKind,
    ).toBe('feature_request');
    expect(
      parseIssueVerdict(JSON.stringify({ ...FULL_VERDICT, issueKind: 'defect' }))
        .verdict?.issueKind,
    ).toBe('bug_report');
    expect(
      parseIssueVerdict(
        JSON.stringify({ ...FULL_VERDICT, issueKind: 'support' }),
      ).verdict?.issueKind,
    ).toBe('question');
  });

  test('drops bugConfirmed on a non-bug verdict (scoped to bug reports)', () => {
    // The output contract annotates bugConfirmed "bug reports only": a feature_request
    // must not carry it even if the model emitted `bugConfirmed: true`.
    const { verdict } = parseIssueVerdict(
      JSON.stringify({
        ...FULL_VERDICT,
        issueKind: 'feature_request',
        bugConfirmed: true,
        prAnalysis: undefined,
      }),
    );
    expect(verdict?.issueKind).toBe('feature_request');
    expect(verdict?.bugConfirmed).toBeUndefined();
  });
});

describe('groundIssueVerdict — drop hallucinated relatedFiles', () => {
  let dir: string;
  /** A REAL file that exists OUTSIDE the project root (a sibling of `dir`), so the
   *  containment test proves the `../` guard drops it — not merely that a non-existent
   *  path is dropped (which the ghost-file test already covers). */
  let outsideAbs: string;
  let outsideRel: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-triage-ground-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'real.ts'), 'a\nb\nc\n');
    const outsideName = `escape-${path.basename(dir)}.ts`;
    outsideAbs = path.join(dir, '..', outsideName);
    outsideRel = `../${outsideName}`;
    fs.writeFileSync(outsideAbs, 'secret\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideAbs, { force: true });
  });

  const base: IssueValidationResult = {
    issueKind: 'bug_report',
    verdict: 'valid',
    confidence: 'high',
    reasoning: 'ok',
    relatedFiles: [],
    missingInfo: [],
  };

  test('keeps existing paths and drops the ones that do not resolve', () => {
    const grounded = groundIssueVerdict(
      { ...base, relatedFiles: ['src/real.ts', 'src/ghost.ts'] },
      dir,
    );
    expect(grounded.relatedFiles).toEqual(['src/real.ts']);
  });

  test('drops a path escaping the project root (containment)', () => {
    // `outsideRel` resolves to a file that DOES exist — so the ONLY thing that can drop
    // it is the `../` containment guard. If that guard were removed, this test fails
    // (the escaping-but-existing path would survive), unlike a ghost path which any
    // stat check would reject.
    expect(fs.existsSync(outsideAbs)).toBe(true);
    const grounded = groundIssueVerdict(
      { ...base, relatedFiles: [outsideRel, 'src/real.ts'] },
      dir,
    );
    expect(grounded.relatedFiles).toEqual(['src/real.ts']);
  });

  test('never fails the verdict — an all-hallucinated list just empties out', () => {
    const grounded = groundIssueVerdict(
      { ...base, relatedFiles: ['nope/a.ts', 'nope/b.ts'] },
      dir,
    );
    expect(grounded.relatedFiles).toEqual([]);
    expect(grounded.verdict).toBe('valid');
  });
});
