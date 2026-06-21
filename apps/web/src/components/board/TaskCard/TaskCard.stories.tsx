import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { TaskCard } from './TaskCard';
import { TASKS_BY_STATUS } from '../_fixtures';

const meta = {
  title: 'Board/TaskCard',
  component: TaskCard,
  args: {
    selected: false,
    onSelect: fn(),
  },
} satisfies Meta<typeof TaskCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Backlog: Story = { args: { task: TASKS_BY_STATUS.backlog } };
export const Ready: Story = { args: { task: TASKS_BY_STATUS.ready } };
export const Running: Story = { args: { task: TASKS_BY_STATUS.in_progress } };
export const WaitingApproval: Story = {
  args: { task: TASKS_BY_STATUS.waiting_approval },
};
export const Done: Story = { args: { task: TASKS_BY_STATUS.done } };

export const Failed: Story = { args: { task: TASKS_BY_STATUS.failed } };

export const Selected: Story = {
  args: { task: TASKS_BY_STATUS.in_progress, selected: true },
};

/** Play test: clicking the card selects it via onSelect(id). */
export const SelectsOnClick: Story = {
  args: { task: TASKS_BY_STATUS.done },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole('button', { name: /wire up auth guard/i });
    await userEvent.click(card);
    await expect(args.onSelect).toHaveBeenCalledWith('t-done');
  },
};
