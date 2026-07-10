import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

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
    ...over,
  };
}

const meta = {
  title: 'Terminal/TerminalPane',
  component: TerminalPane,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '320px', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalPane>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unconfined identity chrome — the default (and only) PR B posture. */
export const Unconfined: Story = {
  args: { session: session({}) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Your shell — unconfined')).toBeInTheDocument();
  },
};

/** The confined chrome variant (PR C flips this on; it already renders from the
 *  session flag). */
export const Confined: Story = {
  args: { session: session({ confined: true }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Confined to this worktree')).toBeInTheDocument();
  },
};
