import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ProposedSubtask } from '@/lib/bridge';
import { ProposedSubtasksPanel } from './ProposedSubtasksPanel';

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

const meta = {
  title: 'Board/ProposedSubtasksPanel',
  component: ProposedSubtasksPanel,
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
} satisfies Meta<typeof ProposedSubtasksPanel>;

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
