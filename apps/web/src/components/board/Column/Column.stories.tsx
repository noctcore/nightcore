import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Column } from './Column';
import { TASKS_BY_STATUS } from '../_fixtures';

const meta = {
  title: 'Board/Column',
  component: Column,
  args: { selectedId: null, onSelect: fn() },
  decorators: [
    (Story) => (
      <div style={{ height: '70vh', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Column>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { title: 'Backlog', tasks: [] } };

export const Populated: Story = {
  args: {
    title: 'In Progress',
    tasks: [TASKS_BY_STATUS.in_progress, TASKS_BY_STATUS.waiting_approval],
  },
};
