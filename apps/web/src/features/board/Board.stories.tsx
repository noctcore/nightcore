import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Board } from './Board';
import { TASKS_BY_STATUS } from './_fixtures';

const meta = {
  title: 'Board/Board',
  component: Board,
  parameters: { layout: 'fullscreen' },
  args: {
    selectedId: null,
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '70vh', width: '100%' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { tasks: [] } };

export const Populated: Story = {
  args: {
    tasks: [
      TASKS_BY_STATUS.backlog,
      TASKS_BY_STATUS.ready,
      TASKS_BY_STATUS.in_progress,
      TASKS_BY_STATUS.done,
      TASKS_BY_STATUS.failed,
    ],
    selectedId: 't-running',
  },
};
