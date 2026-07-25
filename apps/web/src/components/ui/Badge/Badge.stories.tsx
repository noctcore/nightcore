import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Badge } from './Badge';

const meta = {
  title: 'UI/Badge',
  component: Badge,
  parameters: { layout: 'centered' },
  args: { children: 'beta' },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};

export const Primary: Story = { args: { tone: 'primary', children: 'live' } };

export const Success: Story = { args: { tone: 'success', children: 'passed' } };

export const Warning: Story = { args: { tone: 'warning', children: 'flaky' } };

export const Destructive: Story = {
  args: { tone: 'destructive', children: 'failed' },
};

export const Info: Story = { args: { tone: 'info', children: 'queued' } };

export const RendersLabel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('beta')).toBeInTheDocument();
  },
};
