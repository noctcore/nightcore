import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ProjectContextMenu } from './ProjectContextMenu';

const meta = {
  title: 'UI/ProjectContextMenu',
  component: ProjectContextMenu,
  args: { onEdit: fn(), children: <div className="rounded border p-4">Right-click me</div> },
} satisfies Meta<typeof ProjectContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
