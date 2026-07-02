import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { InteractionDock } from './InteractionDock';

const meta = {
  title: 'Board/InteractionDock',
  component: InteractionDock,
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
} satisfies Meta<typeof InteractionDock>;

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
