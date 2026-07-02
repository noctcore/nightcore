import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PrSummary } from '@/lib/bridge';

import { PrPicker } from './PrPicker';

const SAMPLE: PrSummary[] = [
  {
    number: 128,
    title: 'Harden the worktree isolation gate',
    headRefName: 'nc/worktree-gate',
    author: 'shirone',
    isDraft: false,
    updatedAt: '2026-07-02T12:00:00Z',
  },
  {
    number: 127,
    title: 'Add the PR review scan sibling',
    headRefName: 'feat/pr-review',
    author: 'alice',
    isDraft: true,
    updatedAt: '2026-07-01T09:30:00Z',
  },
  {
    number: 119,
    title: 'Flight-recorder ledger for the runtime tiers',
    headRefName: 'feat/ledger',
    author: 'bob',
    isDraft: false,
    updatedAt: '2026-06-28T15:45:00Z',
  },
];

const meta = {
  title: 'PrReview/PrPicker',
  component: PrPicker,
  parameters: { layout: 'padded' },
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
