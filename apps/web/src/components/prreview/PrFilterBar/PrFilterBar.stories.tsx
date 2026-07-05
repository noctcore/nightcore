import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { PrFilterBar } from './PrFilterBar';

const AUTHORS = ['alice', 'bob', 'carol', 'shirone', 'octocat'];

const meta = {
  title: 'PrReview/PrFilterBar',
  component: PrFilterBar,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-[12px] border border-border p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    authors: AUTHORS,
    selectedAuthors: [],
    onAuthorsChange: fn(),
    selectedStatuses: [],
    onStatusesChange: fn(),
    sort: 'newest',
    onSortChange: fn(),
    hasActiveFilters: false,
    onReset: fn(),
  },
} satisfies Meta<typeof PrFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Filters + a non-default sort active — the reset-all affordance shows. */
export const WithFilters: Story = {
  args: {
    selectedAuthors: ['alice', 'bob'],
    selectedStatuses: ['reviewing', 'posted'],
    sort: 'largest',
    hasActiveFilters: true,
  },
};

export const Disabled: Story = {
  args: { disabled: true, hasActiveFilters: true, selectedAuthors: ['alice'] },
};
