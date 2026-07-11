import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalPane } from './TerminalPane';

// A fabricated (uncached) session — the stories showcase the identity CHROME
// deterministically; the live xterm attach (real echo bytes) is exercised in the
// component test (which cleans up) and dogfood, not in the story suite.
function session(over: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: 'story-session',
    cwd: '/Users/dev/nightcore',
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

const UNLINKED = {
  ungoverned: false,
  linkedTitle: null,
  canLaunchClaude: true,
  onLaunchClaude: fn(),
  onClearLink: fn(),
};

const meta = {
  title: 'Terminal/TerminalPane',
  component: TerminalPane,
  parameters: { layout: 'fullscreen' },
  args: { onRename: fn(), link: UNLINKED },
  decorators: [
    // The pane's hook uses `useToast` (the WebGL context-loss fallback), so it needs
    // a ToastProvider in scope.
    (Story) => (
      <ToastProvider>
        <div style={{ height: '320px', display: 'flex' }}>
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof TerminalPane>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unconfined identity chrome — the default posture. No write-containment hint. */
export const Unconfined: Story = {
  args: { session: session({}) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Your shell — unconfined')).toBeInTheDocument();
    expect(canvas.queryByText(/some shell-startup noise is normal/)).toBeNull();
  },
};

/** The confined chrome variant: the lock label plus the one-line startup-noise hint. */
export const Confined: Story = {
  args: { session: session({ confined: true }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Confined to this worktree')).toBeInTheDocument();
    await expect(
      canvas.getByText('Writes outside this folder are blocked — some shell-startup noise is normal.'),
    ).toBeInTheDocument();
  },
};

/** A renamed session (decision 5): the header title shows the manual name instead
 *  of the cwd leaf. */
export const Renamed: Story = {
  args: { session: session({ title: 'deploy shell' }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('deploy shell')).toBeInTheDocument();
  },
};

/** A task-linked, Claude-launched session (decisions 2 & 3): the ungoverned marker,
 *  the linked-task chip, and the Launch-Claude affordance. */
export const LinkedToTask: Story = {
  args: {
    session: session({}),
    link: { ...UNLINKED, ungoverned: true, linkedTitle: 'Add dark-mode toggle' },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Task: Add dark-mode toggle')).toBeInTheDocument();
    await expect(canvas.getByText('Ungoverned')).toBeInTheDocument();
  },
};
