import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { QuestionPrompt } from './QuestionPrompt';

const meta = {
  title: 'Board/QuestionPrompt',
  component: QuestionPrompt,
  parameters: { layout: 'centered' },
  args: { onAnswer: fn() },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QuestionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleQuestion: Story = {
  args: {
    prompt: {
      taskId: 't-running',
      requestId: 'q-1',
      questions: [
        {
          question: 'Which auth method should we use?',
          header: 'Auth method',
          options: [
            { label: 'OAuth', description: 'Delegate to an identity provider.' },
            { label: 'JWT', description: 'Self-issued signed tokens.' },
          ],
          multiSelect: false,
        },
      ],
    },
  },
};

export const MultiSelect: Story = {
  args: {
    prompt: {
      taskId: 't-running',
      requestId: 'q-2',
      questions: [
        {
          question: 'Which features should we enable?',
          header: 'Features',
          options: [
            { label: 'Search', description: 'Full-text search.' },
            { label: 'Export', description: 'CSV export.' },
            { label: 'Webhooks', description: 'Outbound webhooks.' },
          ],
          multiSelect: true,
        },
      ],
    },
  },
};
