import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { BoardDnd } from './BoardDnd';
import { Column } from '../Column';
import { TASKS_BY_STATUS } from '../_fixtures';

const TASKS = [TASKS_BY_STATUS.backlog, TASKS_BY_STATUS.done];

const meta = {
  title: 'Board/BoardDnd',
  component: BoardDnd,
  args: {
    tasks: TASKS,
    onMoveTask: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '60vh', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BoardDnd>;

export default meta;
type Story = StoryObj<typeof meta>;

const columnArgs = {
  selectedId: null,
  blockedIds: new Set<string>(),
  logCounts: {},
  onSelect: fn(),
  onMoveTask: fn(),
};

/** Two droppable columns with draggable cards, inside the board's drag context.
 *  The Backlog card carries the grab affordance; dropping it on Done would relay
 *  `onMoveTask('t-backlog', 'done')`. */
export const WrapsColumns: Story = {
  args: {
    children: (
      <div style={{ display: 'flex', gap: 14 }}>
        <Column
          title="Backlog"
          dotColor="oklch(62% .02 290)"
          dropStatus="backlog"
          tasks={[TASKS_BY_STATUS.backlog]}
          {...columnArgs}
        />
        <Column
          title="Done"
          dotColor="oklch(76% .15 152)"
          dropStatus="done"
          clearable
          tasks={[TASKS_BY_STATUS.done]}
          {...columnArgs}
        />
      </div>
    ),
  },
};
