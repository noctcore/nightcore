import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { BrandMark } from './BrandMark';

const meta = {
  title: 'UI/BrandMark',
  component: BrandMark,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof BrandMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Large: Story = { args: { size: 96 } };

export const RendersMark: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Nightcore' })).toBeInTheDocument();
  },
};
