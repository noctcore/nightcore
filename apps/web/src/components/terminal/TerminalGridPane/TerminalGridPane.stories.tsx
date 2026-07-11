import { DndContext } from '@dnd-kit/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalGridPane } from './TerminalGridPane';

// A fabricated (uncached) session — the stories showcase the pane CHROME
// deterministically; `attachSession` is a no-op for an uncached id, so no real
// xterm is opened (the live attach is covered by the component test + dogfood).
function session(over: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: 'grid-session',
    cwd: '/Users/dev/nightcore',
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: Date.now(),
    title: null,
    titleSource: null,
    ...over,
  };
}

const meta = {
  title: 'Terminal/TerminalGridPane',
  component: TerminalGridPane,
  parameters: { layout: 'fullscreen' },
  args: {
    session: session({}),
    attention: { unread: 0, needsAttention: false },
    ungoverned: false,
    canLaunch: true,
    zoomed: false,
    draggable: true,
    broadcasting: false,
    isDropTarget: false,
    onRename: fn(),
    onLaunchClaude: fn(),
    onToggleZoom: fn(),
    onActivate: fn(),
  },
  decorators: [
    // The pane's attach hook uses `useToast`; the drag/drop hooks read a
    // `<DndContext>` (they no-op outside one, but the real grid provides it).
    (Story) => (
      <ToastProvider>
        <DndContext>
          <div style={{ height: '280px', width: '440px', display: 'flex' }}>
            <Story />
          </div>
        </DndContext>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof TerminalGridPane>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default grid pane: header with a reorder grip, title, and a Maximize button. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: /Maximize pane/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Reorder/ })).toBeInTheDocument();
  },
};

/** A zoomed pane shows the Restore (minimize) affordance instead of Maximize. */
export const Zoomed: Story = {
  args: { zoomed: true, draggable: false },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: /Restore grid/ })).toBeInTheDocument();
    // Reorder is disabled while zoomed — no grip.
    expect(canvas.queryByRole('button', { name: /Reorder/ })).toBeNull();
  },
};

/** An off-screen pane badges its unread output (has-output, T11). */
export const WithUnread: Story = {
  args: { attention: { unread: 7, needsAttention: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('7')).toBeInTheDocument();
  },
};

/** A needs-attention pane (an OSC/BEL completion fired while off-screen) shows the
 *  LOUD warning dot instead of the count (T11). */
export const NeedsAttention: Story = {
  args: { attention: { unread: 3, needsAttention: true } },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText('Waiting for you — a command finished')).toBeInTheDocument();
  },
};

/** A renamed pane shows its manual title. */
export const Renamed: Story = {
  args: { session: session({ title: 'deploy shell' }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('deploy shell')).toBeInTheDocument();
  },
};

/** Clicking the zoom button toggles zoom via `onToggleZoom`. */
export const TogglesZoom: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: /Maximize pane/ }));
    await expect(args.onToggleZoom).toHaveBeenCalledWith('grid-session');
  },
};

/** The one-click Claude launch (decision 3) rides in the grid pane header too, the
 *  same affordance as the tab pane — clicking it types the composed launch command. */
export const LaunchesClaude: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Launch Claude' }));
    await expect(args.onLaunchClaude).toHaveBeenCalled();
  },
};

/** A non-POSIX shell (Windows) can't run the composed launch — no Launch button. */
export const NoLaunchOnNonPosix: Story = {
  args: { canLaunch: false },
  play: async ({ canvas }) => {
    expect(canvas.queryByRole('button', { name: 'Launch Claude' })).toBeNull();
  },
};

/** A pane receiving broadcast input (round-2 PR B, § B.3): the LOUD "BCAST" chip in
 *  the header marks it as one of the panes keystrokes are fanning out to. */
export const Broadcasting: Story = {
  args: { broadcasting: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('BCAST')).toBeInTheDocument();
    await expect(canvas.getByLabelText('Receiving broadcast input')).toBeInTheDocument();
  },
};
