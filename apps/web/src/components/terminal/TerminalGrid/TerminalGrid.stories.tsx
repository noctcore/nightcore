import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalGrid } from './TerminalGrid';

// Fabricated (uncached) sessions — the grid renders each pane's CHROME
// deterministically; `attachSession` is a no-op for an uncached id, so no real
// xterm is opened (the live attach + reorder DOM stability are covered by the
// component test + dogfood).
function session(id: string, over: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id,
    cwd: `/Users/dev/nightcore/.nightcore/worktrees/${id}`,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: Date.now(),
    title: null,
    ...over,
  };
}

const FOUR: TerminalSessionInfo[] = [
  session('task-42', { title: 'api' }),
  session('task-91'),
  session('task-12', { confined: true }),
  session('task-77'),
];

const meta = {
  title: 'Terminal/TerminalGrid',
  component: TerminalGrid,
  parameters: { layout: 'fullscreen' },
  args: {
    sessions: FOUR,
    unread: {},
    ungovernedIds: new Set<string>(),
    canLaunchClaude: () => true,
    zoomedId: null,
    onRename: fn(),
    onLaunchClaude: fn(),
    onReorder: fn(),
    onToggleZoom: fn(),
    onActivate: fn(),
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div style={{ height: '520px', width: '820px', display: 'flex' }}>
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof TerminalGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Four panes → a 2×2 auto-layout, each with its own header + zoom control. */
export const FourPanes: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('button', { name: /Maximize pane/ })).toHaveLength(4);
  },
};

/** Every POSIX pane carries its own Launch-Claude affordance (decision 3), the same
 *  one the tab pane has — not just the active tab. */
export const LaunchPerPane: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('button', { name: 'Launch Claude' })).toHaveLength(4);
  },
};

/** Two panes → a 1×2 layout. */
export const TwoPanes: Story = {
  args: { sessions: [session('task-42'), session('task-91')] },
};

/** A zoomed pane replaces the grid; the others stay alive in the manager. Only the
 *  zoomed pane renders, with a Restore affordance. */
export const Zoomed: Story = {
  args: { zoomedId: 'task-91' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: /Restore grid/ })).toBeInTheDocument();
    // No Maximize buttons while zoomed (only the one Restore button shows).
    expect(canvas.queryByRole('button', { name: /Maximize pane/ })).toBeNull();
  },
};

/** Unread badges on off-screen panes (decision 6c). */
export const WithBadges: Story = {
  args: { unread: { 'task-42': 4, 'task-77': 128 } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('4')).toBeInTheDocument();
    await expect(canvas.getByText('99+')).toBeInTheDocument();
  },
};
