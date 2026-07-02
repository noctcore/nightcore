import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask } from '../_fixtures';
import { TaskAttachments } from './TaskAttachments';

const withImages = makeTask({
  attachments: [
    { id: 'a', filename: 'login-screen.png', format: 'png', size: 24_000 },
    { id: 'b', filename: 'error-state.png', format: 'png', size: 18_400 },
  ],
});

const meta = {
  title: 'Board/TaskAttachments',
  component: TaskAttachments,
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskAttachments>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pre-run task, no images yet — the full add dropzone. */
export const EmptyEditable: Story = { args: { task: makeTask(), editable: true } };

/** Pre-run task with images — add + remove available. (Outside Tauri the previews
 *  fall back to placeholder tiles since the bytes can't be read.) */
export const Editable: Story = { args: { task: withImages, editable: true } };

/** A task that has run — read-only thumbnail grid, no add/remove. */
export const ReadOnly: Story = { args: { task: withImages, editable: false } };
