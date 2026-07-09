import type { PrReviewComments, PrStatus } from '@/lib/bridge';

/** Build a PrStatus fixture for the PrStatusCard stories/tests. Defaults to a
 *  clean, open, review-pending PR against `main` with no check runs. */
export function makePrStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checksPassed: 0,
    checksFailed: 0,
    checksPending: 0,
    baseRefName: 'main',
    headRefOid: 'a1b2c3d4',
    url: 'https://github.com/acme/nightcore/pull/123',
    number: 123,
    unpushedCommits: 0,
    ...overrides,
  };
}

/** Build a PrReviewComments fixture for the PrReviewComments stories/tests.
 *  Defaults to one unresolved inline thread + one changes-requested review
 *  summary; override to exercise the empty / outdated / multi-thread shapes. The
 *  comment bodies stand in for UNTRUSTED external text. */
export function makePrReviewComments(overrides: Partial<PrReviewComments> = {}): PrReviewComments {
  return {
    threads: overrides.threads ?? [
      {
        path: 'src/auth/guard.ts',
        line: 42,
        isOutdated: false,
        comments: [
          {
            author: 'octo-reviewer',
            body: 'This guard never handles the null-session case — it will throw on an anonymous request.',
          },
        ],
      },
    ],
    reviews: overrides.reviews ?? [
      {
        author: 'octo-reviewer',
        state: 'CHANGES_REQUESTED',
        body: 'A couple of edge cases need covering before this can land.',
      },
    ],
  };
}
