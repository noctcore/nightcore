import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from '../Button';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'UI/EmptyState',
  component: EmptyState,
  parameters: { layout: 'centered' },
  args: { title: 'No tasks yet' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {};

export const WithDescription: Story = {
  args: { description: 'Create a task to get started.' },
};

export const WithAction: Story = {
  args: {
    description: 'Create a task to get started.',
    action: <Button>New task</Button>,
  },
};

export const RendersTitle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No tasks yet')).toBeInTheDocument();
  },
};
