import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { Project } from '@/lib/bridge';

import type { NavItem } from '../AppShell/AppShell.types';
import { Sidebar } from './Sidebar';
import type { ProjectSwitcherSurface } from './Sidebar.types';

const NAV: NavItem[] = [
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: '▦', group: 'project' },
  { view: 'settings', label: 'Settings', hint: 'S', icon: '⚙', group: 'settings' },
];

const PROJECTS: Project[] = [
  {
    id: 'nightcore',
    name: 'nightcore',
    path: '~/dev/nightcore',
    branch: 'main',
    createdAt: '2026-06-21T00:00:00Z',
    lastActiveAt: '2026-06-21T00:00:00Z',
    icon: 'FolderCode' as string | null,
    customIconPath: null as string | null,
  },
  {
    id: 'automaker',
    name: 'automaker (legacy)',
    path: '~/dev/automaker',
    branch: 'main',
    createdAt: '2026-06-20T00:00:00Z',
    lastActiveAt: null,
    icon: null,
    customIconPath: null,
  },
];

const switcher: ProjectSwitcherSurface = {
  projects: PROJECTS,
  active: PROJECTS[0] ?? null,
  switcherOpen: false,
  onToggleSwitcher: fn(),
  onCloseSwitcher: fn(),
  onPickProject: fn(),
  onNewProject: fn(),
  onEditProject: fn(),
  onRemoveProject: fn(),
};

const meta = {
  title: 'App/Sidebar',
  component: Sidebar,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: 520, display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    switcher,
    view: 'board',
    nav: NAV,
    collapsed: false,
    sidebarStyle: 'unified' as const,
    runningCount: 0,
    awaitingInputCount: 0,
    version: 'v0.1.0',
    onToggleCollapsed: fn(),
    onNavigate: fn(),
    onGotoProjects: fn(),
    onGotoAwaitingInput: fn(),
  },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unified: Story = {};

export const Classic: Story = {
  args: { sidebarStyle: 'classic' },
};

export const SwitcherOpen: Story = {
  args: { switcher: { ...switcher, switcherOpen: true } },
};

export const Running: Story = {
  args: { runningCount: 2 },
};

export const AwaitingInput: Story = {
  args: { awaitingInputCount: 2 },
};

export const Collapsed: Story = {
  args: { collapsed: true },
};

export const UpdateAvailable: Story = {
  args: { update: { version: '0.2.0', onGoto: fn() } },
};
