import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { SidebarUnified } from './SidebarUnified';

const project = {
  id: 'p1',
  name: 'nightcore',
  path: '~/dev/nightcore',
  branch: 'main',
  createdAt: '2026-06-21T00:00:00Z',
  lastActiveAt: null,
  icon: 'FolderCode',
  customIconPath: null,
};

const meta = {
  title: 'App/SidebarUnified',
  component: SidebarUnified,
  args: {
    switcher: {
      projects: [project],
      active: project,
      switcherOpen: false,
      onToggleSwitcher: fn(),
      onPickProject: fn(),
      onNewProject: fn(),
      onEditProject: fn(),
    },
    collapsed: false,
  },
} satisfies Meta<typeof SidebarUnified>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
