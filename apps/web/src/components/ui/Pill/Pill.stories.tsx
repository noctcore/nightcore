import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Pill } from './Pill';

const meta = {
  title: 'UI/Pill',
  component: Pill,
  parameters: { layout: 'centered' },
  args: { children: 'v1.2.3' },
} satisfies Meta<typeof Pill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RendersValue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('v1.2.3')).toBeInTheDocument();
  },
};
