import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { Column } from '../Column';
import { BoardDnd } from './BoardDnd';
import type { BoardDndProps } from './BoardDnd.types';

const TASKS = [TASKS_BY_STATUS.backlog, TASKS_BY_STATUS.done];

/** One stable no-op action group — the cards (and the drag-overlay preview card)
 *  read their handlers from `TaskActionsContext` now, not props. */
const STORY_ACTIONS = makeTaskActions();

/** The story fixture: the drag context wrapped in the provider its cards require. */
function BoardDndFixture(props: BoardDndProps) {
  return (
    <TaskActionsProvider actions={STORY_ACTIONS}>
      <BoardDnd {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/BoardDnd',
  component: BoardDndFixture,
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
} satisfies Meta<typeof BoardDndFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

const columnArgs = {
  selectedId: null,
  blockedIds: new Set<string>(),
  logCounts: {},
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
