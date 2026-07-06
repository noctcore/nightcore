import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { ProposedSubtask } from '@/lib/bridge';

import { makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { ProposedSubtasksPanel } from './ProposedSubtasksPanel';
import type { ProposedSubtasksPanelProps } from './ProposedSubtasksPanel.types';

const open = (id: string, title: string, prompt: string): ProposedSubtask => ({
  id,
  title,
  prompt,
  status: 'open',
  linkedTaskId: null,
});

const S1 = open('s-1', 'Add the schema', 'Create the proposed_subtasks table and migration.');
const S2 = open('s-2', 'Wire the convert command', 'Add convert_subtask + register it in lib.rs.');
const S3 = open('s-3', 'Build the detail panel', 'Render the proposals with a convert action.');
const SUBTASKS: ProposedSubtask[] = [S1, S2, S3];

const converted = (s: ProposedSubtask, taskId: string): ProposedSubtask => ({
  ...s,
  status: 'converted',
  linkedTaskId: taskId,
});

/** The story fixture: the panel wrapped in the `TaskActionsProvider` it now
 *  reads the convert handlers from. The handlers stay story ARGS so plays and
 *  tests keep overriding them per render. */
function ProposedSubtasksPanelFixture({
  onConvert,
  onConvertAll,
  ...props
}: ProposedSubtasksPanelProps & {
  onConvert?: (parentId: string, subtaskId: string) => void;
  onConvertAll?: (parentId: string) => void;
}) {
  return (
    <TaskActionsProvider
      actions={makeTaskActions({
        onConvertSubtask: onConvert,
        onConvertAllSubtasks: onConvertAll,
      })}
    >
      <ProposedSubtasksPanel {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/ProposedSubtasksPanel',
  component: ProposedSubtasksPanelFixture,
  args: {
    taskId: 'task-decompose-1',
    subtasks: SUBTASKS,
    onConvert: fn(),
    onConvertAll: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 448, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProposedSubtasksPanelFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PartiallyConverted: Story = {
  args: {
    subtasks: [converted(S1, 'child-1'), S2, S3],
  },
};

export const AllConverted: Story = {
  args: {
    subtasks: [
      converted(S1, 'child-1'),
      converted(S2, 'child-2'),
      converted(S3, 'child-3'),
    ],
  },
};

export const Pending: Story = { args: { pending: true } };

/** A decompose run that finished with nothing to convert — the notice replaces the
 *  (absent) convert list so the band never renders blank. */
export const Empty: Story = { args: { subtasks: [] } };

/** A decompose run that FAILED to produce proposals (e.g. the SDK exhausted its
 *  structured-output retries): the notice carries the failure reason. */
export const EmptyWithError: Story = {
  args: {
    subtasks: [],
    error: 'Decompose could not produce a valid sub-task list (structured output retries exhausted).',
  },
};

/** Play test: converting one proposal threads (taskId, subtaskId) through. The
 *  per-row button's accessible name carries its title (Convert all is separate). */
export const PicksConvert: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /convert to task: add the schema/i }));
    await expect(args.onConvert).toHaveBeenCalledWith('task-decompose-1', 's-1');
  },
};

/** Play test: Convert all fires the bulk handler with the parent task id. */
export const PicksConvertAll: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /convert all/i }));
    await expect(args.onConvertAll).toHaveBeenCalledWith('task-decompose-1');
  },
};
