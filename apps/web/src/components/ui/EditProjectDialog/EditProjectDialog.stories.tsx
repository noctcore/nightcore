import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { EditProjectDialog } from './EditProjectDialog';

const meta = {
  title: 'UI/EditProjectDialog',
  component: EditProjectDialog,
  args: {
    open: true,
    onClose: fn(),
    onSave: fn(async () => {}),
    project: {
      id: 'p1',
      name: 'nightcore',
      path: '~/dev/nightcore',
      branch: 'main',
      createdAt: '2026-06-21T00:00:00Z',
      lastActiveAt: null,
      icon: 'FolderCode',
      customIconPath: null,
    },
  },
} satisfies Meta<typeof EditProjectDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
