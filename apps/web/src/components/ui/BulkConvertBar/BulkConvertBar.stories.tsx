import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { BulkConvertBar } from './BulkConvertBar';

const meta = {
  title: 'UI/BulkConvertBar',
  component: BulkConvertBar,
  args: {
    count: 5,
    converting: false,
    progress: { done: 0, total: 0 },
    statusMessage: '',
    error: null,
    onConvertAll: fn(),
  },
} satisfies Meta<typeof BulkConvertBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Idle results toolbar: the button names the open count and is live. */
export const Default: Story = {};

/** Nothing left to convert — the button is inert (aria-disabled, `(0)`). */
export const NothingOpen: Story = { args: { count: 0 } };

/** In-flight: the label swaps to the running `Converting… k/N` progress. */
export const Converting: Story = {
  args: {
    converting: true,
    progress: { done: 2, total: 5 },
    statusMessage: 'Converting 2/5…',
  },
};

/** Settled with a partial failure: the inline summary surfaces beside the button. */
export const PartialFailure: Story = {
  args: {
    error: '1 of 5 findings could not be converted.',
    statusMessage: 'Converted 4 findings (1 failed).',
  },
};

/** A trailing sibling action (e.g. the scan views' "Export to GitHub" button)
 *  shares the SAME bar as convert-all rather than stacking a second bar. */
export const WithTrailingAction: Story = {
  args: {
    trailing: <button type="button">Export to GitHub</button>,
  },
};
