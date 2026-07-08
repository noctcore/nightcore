import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { SearchIcon } from '../icons';
import { IconTile } from './IconTile';

const meta = {
  title: 'UI/IconTile',
  component: IconTile,
  parameters: { layout: 'centered' },
  args: { children: <SearchIcon size={18} /> },
} satisfies Meta<typeof IconTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Medium: Story = {};

export const Small: Story = { args: { size: 'sm' } };

export const Large: Story = { args: { size: 'lg' } };

export const RendersIcon: Story = {
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('svg')).not.toBeNull();
  },
};
