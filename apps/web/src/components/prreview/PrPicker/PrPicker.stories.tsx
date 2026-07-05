import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PrSummary } from '@/lib/bridge';

import { deriveReviewLifecycle } from '../prreview-lifecycle';
import { EMPTY_REVIEW_STREAM } from '../prreview-stream';
import { PrPicker } from './PrPicker';

/** A reviewing (streaming) lifecycle for the picker-row badge demo. */
const REVIEWING = deriveReviewLifecycle({
  stream: { ...EMPTY_REVIEW_STREAM, status: 'running', prNumber: 128 },
  latestRun: null,
  fix: null,
  prStatus: null,
});

/** A completed-but-unposted lifecycle (the "Reviewed" row badge). */
const REVIEWED = deriveReviewLifecycle({
  stream: { ...EMPTY_REVIEW_STREAM, status: 'completed', prNumber: 127 },
  latestRun: null,
  fix: null,
  prStatus: null,
});

function sample(over: Partial<PrSummary> & Pick<PrSummary, 'number'>): PrSummary {
  return {
    title: 'Untitled',
    state: 'OPEN',
    headRefName: 'branch',
    author: 'octocat',
    isDraft: false,
    createdAt: '2026-06-20T09:00:00Z',
    updatedAt: '2026-07-02T12:00:00Z',
    url: `https://github.com/o/r/pull/${over.number}`,
    labels: [],
    body: '',
    additions: 0,
    deletions: 0,
    ...over,
  };
}

const SAMPLE: PrSummary[] = [
  sample({
    number: 128,
    title: 'Harden the worktree isolation gate',
    headRefName: 'nc/worktree-gate',
    author: 'shirone',
    labels: [{ name: 'security', color: 'd73a4a' }],
    additions: 120,
    deletions: 14,
    createdAt: '2026-07-02T09:00:00Z',
  }),
  sample({
    number: 127,
    title: 'Add the PR review scan sibling',
    headRefName: 'feat/pr-review',
    author: 'alice',
    isDraft: true,
    additions: 8,
    deletions: 2,
    createdAt: '2026-06-28T09:00:00Z',
  }),
  sample({
    number: 119,
    title: 'Flight-recorder ledger for the runtime tiers',
    headRefName: 'feat/ledger',
    author: 'bob',
    additions: 60,
    deletions: 5,
    createdAt: '2026-06-20T09:00:00Z',
  }),
];

const meta = {
  title: 'PrReview/PrPicker',
  component: PrPicker,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-[400px] flex-col border border-border">
        <Story />
      </div>
    ),
  ],
  args: {
    prs: SAMPLE,
    loading: false,
    error: null,
    value: null,
    onChange: fn(),
    onRefresh: fn(),
  },
} satisfies Meta<typeof PrPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loaded: Story = {};

export const Selected: Story = {
  args: { value: 127 },
};

/** Review-position badges: #128 has a review streaming, #127's latest completed
 *  run left 3 open findings. */
export const WithRunBadges: Story = {
  args: {
    statuses: { 128: REVIEWING, 127: REVIEWED },
    findingCounts: { 127: 3 },
  },
};

export const Loading: Story = {
  args: { prs: [], loading: true },
};

export const Empty: Story = {
  args: { prs: [] },
};

export const Error: Story = {
  args: {
    prs: [],
    error: 'gh: no default remote repository detected',
  },
};

/** More PRs may exist beyond the fetch cap — the footer offers "Load more". */
export const LoadMore: Story = {
  args: { hasMore: true, onLoadMore: fn() },
};

/** The list is fully loaded — the footer reads "All pull requests loaded". */
export const AllLoaded: Story = {
  args: { hasMore: false, onLoadMore: fn() },
};
