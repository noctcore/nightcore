import type { Meta, StoryObj } from '@storybook/react-vite';
import { TaskStatusDot } from './TaskStatusDot';

const meta = {
  title: 'Board/TaskStatusDot',
  component: TaskStatusDot,
  args: { glow: true },
} satisfies Meta<typeof TaskStatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Backlog: Story = { args: { status: 'backlog' } };
export const Running: Story = { args: { status: 'in_progress' } };
export const Done: Story = { args: { status: 'done' } };
export const Failed: Story = { args: { status: 'failed' } };
