import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { PermissionPrompt } from './PermissionPrompt';

const meta = {
  title: 'Board/PermissionPrompt',
  component: PermissionPrompt,
  parameters: { layout: 'centered' },
  args: { onRespond: fn() },
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShellCommand: Story = {
  args: {
    prompt: {
      taskId: 't-running',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf node_modules && bun install' },
    },
  },
};

export const FileEdit: Story = {
  args: {
    prompt: {
      taskId: 't-running',
      requestId: 'req-2',
      toolName: 'Edit',
      input: { file_path: '/repo/src/index.ts', old_string: 'a', new_string: 'b' },
    },
  },
};
