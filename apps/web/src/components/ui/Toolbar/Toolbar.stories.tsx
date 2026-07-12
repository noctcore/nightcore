import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from '../Button';
import { SearchIcon, SlidersIcon } from '../icons';
import { Toolbar } from './Toolbar';

const meta = {
  title: 'UI/Toolbar',
  component: Toolbar,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Toolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A labelled control group of fixed buttons — the Board-header use case. Every
 *  child is pinned `shrink-0`, so a narrow viewport wraps controls instead of
 *  squishing them. Resize the Storybook canvas to see the row wrap. */
export const FixedControls: Story = {
  args: {
    label: 'Board actions',
    children: (
      <>
        <Button variant="secondary">
          <SlidersIcon size={14} />
          Provider
        </Button>
        <Button variant="secondary">Auto Mode</Button>
        <Button>New task</Button>
      </>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole('group', { name: 'Board actions' });
    await expect(group).toHaveClass('flex-wrap');
    await expect(canvas.getByRole('button', { name: 'New task' })).toBeVisible();
  },
};

/** A toolbar with one flexible child (a search box) that grows to fill the row via
 *  `min-w-0 grow basis-0`, while the trailing button stays fixed. */
export const WithFlexibleChild: Story = {
  args: {
    label: 'Search and filter',
    children: (
      <>
        <div className="flex min-w-0 grow basis-0 items-center gap-2 rounded-[9px] border border-border bg-white/[0.02] px-3 py-2">
          <SearchIcon size={15} className="text-muted-foreground" />
          <input
            aria-label="Search"
            placeholder="Search…"
            className="min-w-0 flex-1 bg-transparent text-xs-plus2 text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Button variant="secondary">Filter</Button>
      </>
    ),
  },
};
