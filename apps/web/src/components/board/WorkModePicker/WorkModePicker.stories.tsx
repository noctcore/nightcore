import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { WorkModePicker } from './WorkModePicker';

const meta = {
  title: 'Board/WorkModePicker',
  component: WorkModePicker,
  args: {
    value: 'main',
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkModePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Main: Story = {};

export const Worktree: Story = { args: { value: 'worktree' } };

export const Disabled: Story = { args: { disabled: true } };

/** Play test: picking Worktree fires onChange with 'worktree'. */
export const PicksWorktree: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /worktree/i }));
    await expect(args.onChange).toHaveBeenCalledWith('worktree');
  },
};

/** Play test: the explainer reflects the selected mode. */
export const ShowsExplainer: Story = {
  args: { value: 'worktree' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/isolates this task on its own branch/i)).toBeInTheDocument();
  },
};
