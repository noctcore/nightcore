import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { SessionComposer } from './SessionComposer';
import type { SessionComposerProps } from './SessionComposer.types';

/** The story fixture: the composer wrapped in the `TaskActionsProvider` it reads its
 *  `onSendInput` relay from. The handler stays a story ARG so plays/tests keep
 *  overriding it per render. */
function SessionComposerFixture({
  onSendInput,
  ...props
}: SessionComposerProps & {
  onSendInput?: (taskId: string, text: string) => void;
}) {
  return (
    <TaskActionsProvider actions={makeTaskActions({ onSendInput })}>
      <SessionComposer {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/SessionComposer',
  component: SessionComposerFixture,
  args: {
    taskId: 't-running',
    onSendInput: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionComposerFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One live session — the composer sends to that session alone; no broadcast toggle. */
export const Single: Story = {
  args: { liveSessionIds: ['t-running'] },
};

/** Multiple live sessions — the broadcast toggle appears, arming a fan-out to all. */
export const Broadcast: Story = {
  args: { liveSessionIds: ['t-running', 't-other', 't-third'] },
};
