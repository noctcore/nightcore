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

/** A deliberately short viewport with a full nav list AND a tall footer slot (the
 *  usage widget's home). The nav list scrolls inside `flex-1 min-h-0 overflow-y-auto`
 *  while the footer stays pinned (`shrink-0`) — it must NEVER overlap the nav rows
 *  (issue #121 responsive fix). Before the fix, the footer bled over the Harden /
 *  Enforce / Verify rows at small heights. */
export const ConstrainedHeight: Story = {
  decorators: [(Story) => <div style={{ height: 300, display: 'flex' }}><Story /></div>],
  args: {
    nav: [
      { view: 'board', label: 'Kanban Board', hint: 'K', icon: '▦', group: 'project' },
      { view: 'terminal', label: 'Terminal', hint: 'T', icon: '▸', group: 'project' },
      { view: 'understand', label: 'Find & Grade', hint: 'U', icon: '◎', group: 'understand' },
      { view: 'harden', label: 'Conventions', hint: 'H', icon: '◆', group: 'harden' },
      { view: 'enforce', label: 'Enforce', hint: 'E', icon: '▣', group: 'enforce' },
      { view: 'prreview', label: 'PR Review', hint: 'P', icon: '⌥', group: 'verify' },
      { view: 'settings', label: 'Settings', hint: 'S', icon: '⚙', group: 'settings' },
    ],
    slots: {
      footer: (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1.5 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
            Usage
          </div>
          <div className="flex flex-col gap-1.5 px-2">
            <div className="h-1 w-full rounded-full bg-success/60" />
            <div className="h-1 w-full rounded-full bg-warning/60" />
          </div>
        </div>
      ),
    },
  },
};
