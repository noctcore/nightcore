import { describe, expect, it } from 'vitest';

import type { PrFixState, PrReviewRun, PrStatus } from '@/lib/bridge';

import {
  compareRuns,
  deriveReviewLifecycle,
  deriveReviewTimeline,
  isReviewStale,
  LIFECYCLE_FILTER_OPTIONS,
  type LifecycleInputs,
  lifecycleToneClasses,
  reconcilePostedVerdict,
} from './prreview-lifecycle';
import { EMPTY_REVIEW_STREAM, type ReviewStream } from './prreview-stream';

function stream(over: Partial<ReviewStream> = {}): ReviewStream {
  return { ...EMPTY_REVIEW_STREAM, runId: 'run-1', prNumber: 7, ...over };
}

function storedFinding(fingerprint: string, status = 'open') {
  return {
    id: fingerprint,
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: null,
    title: 't',
    body: 'b',
    suggestedFix: null,
    fingerprint,
    corroboratedBy: null,
    status,
    linkedTaskId: null,
  };
}

function run(over: Partial<PrReviewRun> = {}): PrReviewRun {
  return {
    id: 'run-1',
    projectPath: '/proj',
    prNumber: 7,
    status: 'completed',
    lenses: ['logic'],
    model: 'm',
    createdAt: 1000,
    updatedAt: 2000,
    costUsd: 0,
    durationMs: 10,
    usage: { inputTokens: 0, outputTokens: 0 },
    findings: [],
    error: null,
    verdict: null,
    verdictReasoning: null,
    headSha: null,
    postedVerdict: null,
    postedAt: null,
    ...over,
  };
}

function fix(over: Partial<PrFixState> = {}): PrFixState {
  return {
    id: 'prfix-1',
    kind: 'findings',
    runId: 'run-1',
    prNumber: 7,
    branch: 'feat/x',
    dir: '/wt',
    status: 'running',
    summary: null,
    error: null,
    findingCount: 1,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function status(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checksPassed: 3,
    checksFailed: 0,
    checksPending: 0,
    baseRefName: 'main',
    headRefOid: 'sha-live',
    url: 'https://github.com/o/r/pull/7',
    number: 7,
    unpushedCommits: 0,
    ...over,
  };
}

const EMPTY: LifecycleInputs = {
  stream: null,
  latestRun: null,
  fix: null,
  prStatus: null,
};

describe('deriveReviewLifecycle', () => {
  it('not_reviewed when nothing is known for the PR', () => {
    const lc = deriveReviewLifecycle(EMPTY);
    expect(lc.state).toBe('not_reviewed');
    expect(lc.tone).toBe('neutral');
    expect(lc.pulse).toBe(false);
  });

  it('a failed run with no completed result still reads not_reviewed', () => {
    const lc = deriveReviewLifecycle({
      ...EMPTY,
      stream: stream({ status: 'failed' }),
      latestRun: run({ status: 'failed' }),
    });
    expect(lc.state).toBe('not_reviewed');
  });

  it('reviewing wins first — even over an older completed persisted run', () => {
    // A live run is streaming while the persisted head still reads completed:
    // the active review is the position to show (the reference isReviewing gate).
    const lc = deriveReviewLifecycle({
      ...EMPTY,
      stream: stream({ status: 'running' }),
      latestRun: run({ status: 'completed', postedVerdict: 'approve' }),
    });
    expect(lc.state).toBe('reviewing');
    expect(lc.pulse).toBe(true);
  });

  it('reviewing from the optimistic isStarting gap', () => {
    expect(deriveReviewLifecycle({ ...EMPTY, isStarting: true }).state).toBe(
      'reviewing',
    );
  });

  it('fix_in_flight for a running / committing / awaiting_push fix', () => {
    for (const s of ['running', 'committing', 'awaiting_push'] as const) {
      const lc = deriveReviewLifecycle({
        ...EMPTY,
        stream: stream({ status: 'completed' }),
        latestRun: run({ status: 'completed' }),
        fix: fix({ status: s }),
      });
      expect(lc.state).toBe('fix_in_flight');
    }
    // awaiting_push is the human gate — no pulse; the active stages pulse.
    expect(
      deriveReviewLifecycle({
        ...EMPTY,
        latestRun: run(),
        fix: fix({ status: 'awaiting_push' }),
      }).pulse,
    ).toBe(false);
    expect(
      deriveReviewLifecycle({ ...EMPTY, latestRun: run(), fix: fix({ status: 'running' }) })
        .pulse,
    ).toBe(true);
  });

  it('a pushed / failed fix is terminal — it falls through to the review position', () => {
    const lc = deriveReviewLifecycle({
      ...EMPTY,
      latestRun: run({ status: 'completed', findings: [storedFinding('fp1')] }),
      fix: fix({ status: 'pushed' }),
    });
    expect(lc.state).toBe('reviewed_pending_post');
  });

  it('stale when the branch advanced past the reviewed head', () => {
    const lc = deriveReviewLifecycle({
      ...EMPTY,
      latestRun: run({ status: 'completed', headSha: 'sha-old', postedVerdict: 'approve' }),
      prStatus: status({ headRefOid: 'sha-new' }),
    });
    // Staleness beats even a posted verdict.
    expect(lc.state).toBe('stale');
    expect(lc.stale).toBe(true);
    expect(lc.tone).toBe('warning');
  });

  it('posted with a verdict-driven tone', () => {
    const approve = deriveReviewLifecycle({
      ...EMPTY,
      latestRun: run({ headSha: 'sha-live', postedVerdict: 'approve' }),
      prStatus: status({ headRefOid: 'sha-live' }),
    });
    expect(approve.state).toBe('posted');
    expect(approve.tone).toBe('success');

    const changes = deriveReviewLifecycle({
      ...EMPTY,
      latestRun: run({ postedVerdict: 'request-changes' }),
    });
    expect(changes.state).toBe('posted');
    expect(changes.tone).toBe('warning');
  });

  it('reviewed_pending_post with the open-finding count in the description', () => {
    const lc = deriveReviewLifecycle({
      ...EMPTY,
      latestRun: run({
        findings: [storedFinding('a'), storedFinding('b'), storedFinding('c', 'dismissed')],
      }),
    });
    expect(lc.state).toBe('reviewed_pending_post');
    expect(lc.description).toMatch(/2 findings/);
  });

  it('reviewed_pending_post with no open findings reads clean', () => {
    const lc = deriveReviewLifecycle({ ...EMPTY, latestRun: run({ findings: [] }) });
    expect(lc.description).toMatch(/clean/i);
  });
});

describe('lifecycleToneClasses', () => {
  it('maps each tone to a semantic dot + text class', () => {
    expect(lifecycleToneClasses('success').dot).toContain('success');
    expect(lifecycleToneClasses('warning').text).toContain('warning');
    expect(lifecycleToneClasses('neutral').dot).toContain('muted-foreground');
  });
});

describe('isReviewStale', () => {
  it('true only when both SHAs are present, differ, and the PR is open', () => {
    expect(
      isReviewStale(run({ headSha: 'a' }), status({ headRefOid: 'b' })),
    ).toBe(true);
    // Equal → not stale.
    expect(
      isReviewStale(run({ headSha: 'a' }), status({ headRefOid: 'a' })),
    ).toBe(false);
    // Missing reviewed head → never stale (no false alarm on old runs).
    expect(
      isReviewStale(run({ headSha: null }), status({ headRefOid: 'b' })),
    ).toBe(false);
    // Missing live head → never stale.
    expect(isReviewStale(run({ headSha: 'a' }), status({ headRefOid: '' }))).toBe(
      false,
    );
    // Merged PR moving on isn't a stale review.
    expect(
      isReviewStale(run({ headSha: 'a' }), status({ headRefOid: 'b', state: 'MERGED' })),
    ).toBe(false);
    expect(isReviewStale(null, status())).toBe(false);
    expect(isReviewStale(run(), null)).toBe(false);
  });
});

describe('reconcilePostedVerdict', () => {
  it('empty unless the review is approving (posted approve or verdict ready)', () => {
    expect(
      reconcilePostedVerdict(
        run({ postedVerdict: 'comment' }),
        status({ checksFailed: 2 }),
      ),
    ).toEqual([]);
    // A synthesis "ready" verdict counts as approving even if not yet posted.
    expect(
      reconcilePostedVerdict(run({ verdict: 'ready' }), status({ checksFailed: 1 })),
    ).toEqual(['1 check failing']);
  });

  it('names each live contradiction against a posted approval', () => {
    const reasons = reconcilePostedVerdict(
      run({ postedVerdict: 'approve' }),
      status({ checksFailed: 3, mergeStateStatus: 'BEHIND' }),
    );
    expect(reasons).toContain('3 checks failing');
    expect(reasons).toContain('Branch is behind the base');
  });

  it('collapses DIRTY and CONFLICTING into one conflict line', () => {
    const reasons = reconcilePostedVerdict(
      run({ postedVerdict: 'approve' }),
      status({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }),
    );
    expect(reasons.filter((r) => /conflict/i.test(r))).toHaveLength(1);
  });

  it('no contradiction when the live status is clean', () => {
    expect(reconcilePostedVerdict(run({ postedVerdict: 'approve' }), status())).toEqual(
      [],
    );
  });

  it('never contradicts a merged/closed PR', () => {
    expect(
      reconcilePostedVerdict(
        run({ postedVerdict: 'approve' }),
        status({ state: 'MERGED', checksFailed: 2 }),
      ),
    ).toEqual([]);
  });
});

describe('compareRuns', () => {
  it('splits findings into resolved / still-open / new by fingerprint', () => {
    const previous = [storedFinding('a'), storedFinding('b'), storedFinding('c')];
    const latest = [storedFinding('b'), storedFinding('c'), storedFinding('d')];
    const cmp = compareRuns(latest, previous);
    expect(cmp.resolved).toBe(1); // a is gone
    expect(cmp.stillOpen).toBe(2); // b, c persist
    expect(cmp.added).toBe(1); // d is new
    expect([...cmp.recurringFingerprints].sort()).toEqual(['b', 'c']);
  });

  it('handles a fully-resolved re-review', () => {
    const cmp = compareRuns([], [storedFinding('a'), storedFinding('b')]);
    expect(cmp.resolved).toBe(2);
    expect(cmp.stillOpen).toBe(0);
    expect(cmp.added).toBe(0);
  });
});

describe('deriveReviewTimeline', () => {
  it('returns no arc when there is no run', () => {
    expect(deriveReviewTimeline(null, null)).toEqual([]);
  });

  it('shows a single live node while reviewing', () => {
    const steps = deriveReviewTimeline(run({ status: 'running' }), null);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'review', state: 'current' });
  });

  it('a completed unposted run yields reviewed → pending-post', () => {
    const steps = deriveReviewTimeline(
      run({ status: 'completed', findings: [storedFinding('a')] }),
      null,
    );
    expect(steps.map((s) => s.id)).toEqual(['review', 'posted']);
    expect(steps[0]).toMatchObject({ state: 'done', at: 1000 });
    expect(steps[1]).toMatchObject({ label: 'Pending post', state: 'upcoming' });
  });

  it('a posted run + pushed fix + staleness yields the full arc', () => {
    const steps = deriveReviewTimeline(
      run({ status: 'completed', postedVerdict: 'request-changes', postedAt: 3000 }),
      fix({ status: 'pushed', updatedAt: 5000 }),
      true,
    );
    expect(steps.map((s) => s.id)).toEqual(['review', 'posted', 'fix', 're-review']);
    expect(steps[1]).toMatchObject({ label: 'Posted to GitHub', state: 'done', at: 3000 });
    expect(steps[2]).toMatchObject({ label: 'Fix pushed', state: 'done', at: 5000 });
    expect(steps[3]).toMatchObject({ state: 'upcoming' });
  });

  it('a failed run short-circuits to an alert node', () => {
    const steps = deriveReviewTimeline(run({ status: 'failed' }), null);
    expect(steps).toEqual([
      { id: 'review', label: 'Review failed', state: 'alert', at: 2000 },
    ]);
  });
});

describe('LIFECYCLE_FILTER_OPTIONS', () => {
  it('covers every lifecycle state offered as a filter, with labels', () => {
    expect(LIFECYCLE_FILTER_OPTIONS.length).toBeGreaterThan(0);
    for (const opt of LIFECYCLE_FILTER_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
    // The default resting states are all reachable.
    const states = LIFECYCLE_FILTER_OPTIONS.map((o) => o.state);
    expect(states).toContain('not_reviewed');
    expect(states).toContain('reviewing');
    expect(states).toContain('posted');
  });
});
