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
    ...over,
  };
}

const meta = {
  title: 'Terminal/TerminalGridPane',
  component: TerminalGridPane,
  parameters: { layout: 'fullscreen' },
  args: {
    session: session({}),
    unread: 0,
    zoomed: false,
    draggable: true,
    onRename: fn(),
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

/** An off-screen pane badges its unread output (decision 6c). */
export const WithUnread: Story = {
  args: { unread: 7 },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('7')).toBeInTheDocument();
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
