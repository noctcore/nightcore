import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask } from '../_fixtures.task';
import { TaskOverviewEditor } from './TaskOverviewEditor';

const meta = {
  title: 'Board/TaskOverviewEditor',
  component: TaskOverviewEditor,
  args: {
    onChangeTitle: () => {},
    onChangeDescription: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: 380, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskOverviewEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh backlog task — editable title + description, committed on blur / ⌘↵. */
export const Editable: Story = {
  args: {
    task: makeTask({
      status: 'backlog',
      title: 'Migrate the build pipeline to Vite',
      description: 'Swap Webpack for Vite and delete the legacy loader config.',
    }),
  },
};

/** An empty description — the field shows its placeholder. */
export const EmptyDescription: Story = {
  args: {
    task: makeTask({ status: 'backlog', title: 'Add a health-check endpoint', description: '' }),
  },
};
