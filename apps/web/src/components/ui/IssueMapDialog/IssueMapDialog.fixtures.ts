/** Synthetic IssueMapPreview / IssueMapResult fixtures for the dialog's stories
 *  and tests. Kept out of the component so both the seeded stories (via the
 *  `override` seam) and the mocked-bridge tests draw from one shape. */
import type { IssueMapPreview, IssueMapResult } from '@/lib/bridge';

const PARENT_BODY = `### 🌙 Nightcore — Insight map

A concise executive summary of the 6 findings across 3 categories, with 2 high-severity issues to address first.

## Correctness (2)

Two correctness gaps around error handling.

- **Unhandled promise rejection** · high
- **Off-by-one in pagination** · medium

## Performance (2)

- **N+1 query in the list loader** · high
- **Unmemoized hot-path map** · low

## Maintainability (2)

- **God file over 400 lines** · medium
- **Duplicated date helper** · low

---
_From Nightcore Insight run run-abc._
_Posted from Nightcore._`;

/** Build a preview with sensible defaults; override any field per story/test. */
export function makePreview(overrides: Partial<IssueMapPreview> = {}): IssueMapPreview {
  return {
    scanKind: 'insight',
    runId: 'run-abc',
    generatedAt: '2026-07-11T00:00:00Z',
    parentTitle: 'Nightcore Insight map — 6 findings',
    parentBody: PARENT_BODY,
    total: 6,
    subIssues: [
      { title: 'Unhandled promise rejection in the sync worker', groupLabel: 'Correctness' },
      { title: 'Off-by-one in pagination bounds', groupLabel: 'Correctness' },
      { title: 'N+1 query in the list loader', groupLabel: 'Performance' },
      { title: 'Unmemoized hot-path map render', groupLabel: 'Performance' },
      { title: 'God file over the 400-line cap', groupLabel: 'Maintainability' },
      { title: 'Duplicated date helper', groupLabel: 'Maintainability' },
    ],
    groups: [
      { label: 'Correctness', count: 2 },
      { label: 'Performance', count: 2 },
      { label: 'Maintainability', count: 2 },
    ],
    supersedes: null,
    softWarning: null,
    narrative: {
      execSummary: 'A concise executive summary of the 6 findings across 3 categories.',
      groupIntros: [
        { label: 'Correctness', intro: 'Two correctness gaps around error handling.' },
      ],
    },
    narrativeOk: true,
    ...overrides,
  };
}

/** A completed export — full success. */
export const SUCCESS_RESULT: IssueMapResult = {
  parent: {
    number: 128,
    title: 'Nightcore Insight map — 6 findings',
    url: 'https://github.com/acme/widget/issues/128',
  },
  created: 6,
  attempted: 6,
  failedAt: null,
  partial: false,
  error: null,
  degradedLinkage: false,
  supersedeWarning: null,
};

/** A PARTIAL export — stopped mid-run; nothing deleted. */
export const PARTIAL_RESULT: IssueMapResult = {
  parent: {
    number: 129,
    title: 'Nightcore Insight map — 6 findings',
    url: 'https://github.com/acme/widget/issues/129',
  },
  created: 3,
  attempted: 6,
  failedAt: 3,
  partial: true,
  error: 'HTTP 403: secondary rate limit exceeded',
  degradedLinkage: false,
  supersedeWarning: null,
};

/** A DEGRADED-linkage export — all created, but task-list linked. */
export const DEGRADED_RESULT: IssueMapResult = {
  parent: {
    number: 130,
    title: 'Nightcore Insight map — 6 findings',
    url: 'https://github.com/acme/widget/issues/130',
  },
  created: 6,
  attempted: 6,
  failedAt: null,
  partial: false,
  error: null,
  degradedLinkage: true,
  supersedeWarning: null,
};
