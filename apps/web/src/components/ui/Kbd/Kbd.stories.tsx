import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Kbd } from './Kbd';

const meta = {
  title: 'UI/Kbd',
  component: Kbd,
  parameters: { layout: 'centered' },
  args: { children: 'Esc' },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const Combo: Story = { args: { children: '⌘↵' } };

export const RendersKey: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Esc')).toBeInTheDocument();
  },
};
