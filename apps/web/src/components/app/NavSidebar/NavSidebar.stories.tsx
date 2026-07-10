import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { NavSidebar } from './NavSidebar';

const meta = {
  title: 'App/NavSidebar',
  component: NavSidebar,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <div style={{ height: 480, display: 'flex' }}><Story /></div>],
  args: {
    view: 'board',
    nav: [
      { view: 'board', label: 'Kanban Board', hint: 'K', icon: '▦', group: 'project' },
      { view: 'understand', label: 'Find & Grade', hint: 'U', icon: '◎', group: 'understand' },
      { view: 'prreview', label: 'PR Review', hint: 'P', icon: '⌥', group: 'verify' },
      { view: 'settings', label: 'Settings', hint: 'S', icon: '⚙', group: 'settings' },
    ],
    collapsed: false,
    runningCount: 0,
    awaitingInputCount: 0,
    version: 'v0.1.0',
    showHeader: true,
    onToggleCollapsed: fn(),
    onNavigate: fn(),
    onGotoProjects: fn(),
    onGotoAwaitingInput: fn(),
  },
} satisfies Meta<typeof NavSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
