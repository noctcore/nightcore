import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ProjectRail } from './ProjectRail';

const project = {
  id: 'p1',
  name: 'nightcore',
  path: '~/dev/nightcore',
  branch: 'main',
  createdAt: '2026-06-21T00:00:00Z',
  lastActiveAt: null,
  icon: 'Rocket',
  customIconPath: null,
};

const meta = {
  title: 'App/ProjectRail',
  component: ProjectRail,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <div style={{ height: 480, display: 'flex' }}><Story /></div>],
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
    runningCount: 0,
    onGotoProjects: fn(),
  },
} satisfies Meta<typeof ProjectRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
