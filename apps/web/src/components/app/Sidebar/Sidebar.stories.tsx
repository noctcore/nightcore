import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { Project } from '@/lib/bridge';
import { Sidebar } from './Sidebar';
import type { NavItem } from '../AppShell/AppShell.types';

const NAV: NavItem[] = [
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: '▦' },
  { view: 'settings', label: 'Settings', hint: 'S', icon: '⚙' },
];

const PROJECTS: Project[] = [
  {
    id: 'nightcore',
    name: 'nightcore',
    path: '~/dev/nightcore',
    branch: 'main',
    createdAt: '2026-06-21T00:00:00Z',
    lastActiveAt: '2026-06-21T00:00:00Z',
  },
  {
    id: 'automaker',
    name: 'automaker (legacy)',
    path: '~/dev/automaker',
    branch: 'main',
    createdAt: '2026-06-20T00:00:00Z',
    lastActiveAt: null,
  },
];

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
    projects: PROJECTS,
    active: PROJECTS[0],
    view: 'board',
    nav: NAV,
    collapsed: false,
    switcherOpen: false,
    runningCount: 0,
    version: 'v0.1.0',
    onToggleCollapsed: fn(),
    onToggleSwitcher: fn(),
    onNavigate: fn(),
    onGotoProjects: fn(),
    onPickProject: fn(),
    onNewProject: fn(),
  },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SwitcherOpen: Story = {
  args: { switcherOpen: true },
};

export const Running: Story = {
  args: { runningCount: 2 },
};

export const Collapsed: Story = {
  args: { collapsed: true },
};
