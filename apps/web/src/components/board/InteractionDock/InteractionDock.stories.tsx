import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { QuestionAnswer } from '@/lib/bridge';

import { makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { InteractionDock } from './InteractionDock';
import type { InteractionDockProps } from './InteractionDock.types';

/** The story fixture: the dock wrapped in the `TaskActionsProvider` it now reads
 *  its relay handlers from. The handlers stay story ARGS so plays and tests keep
 *  overriding them per render. */
function InteractionDockFixture({
  onRespondPermission,
  onAnswerQuestion,
  ...props
}: InteractionDockProps & {
  onRespondPermission?: (
    taskId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => void;
  onAnswerQuestion?: (taskId: string, requestId: string, answer: QuestionAnswer) => void;
}) {
  return (
    <TaskActionsProvider
      actions={makeTaskActions({ onRespondPermission, onAnswerQuestion })}
    >
      <InteractionDock {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/InteractionDock',
  component: InteractionDockFixture,
  args: {
    taskId: 't-running',
    onRespondPermission: fn(),
    onAnswerQuestion: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InteractionDockFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

const permission = {
  taskId: 't-running',
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'rm -rf node_modules && bun install' },
};

const question = {
  taskId: 't-running',
  requestId: 'q-1',
  questions: [
    {
      question: 'Which approach should we take?',
      header: 'Approach',
      options: [
        { label: 'Incremental', description: 'Ship in small steps.' },
        { label: 'Big bang', description: 'Land it all at once.' },
      ],
      multiSelect: false,
    },
  ],
};

export const Empty: Story = {
  args: { permissionPrompts: [], questionPrompts: [] },
};

export const QuestionOnly: Story = {
  args: { permissionPrompts: [], questionPrompts: [question] },
};

export const Both: Story = {
  args: { permissionPrompts: [permission], questionPrompts: [question] },
};
