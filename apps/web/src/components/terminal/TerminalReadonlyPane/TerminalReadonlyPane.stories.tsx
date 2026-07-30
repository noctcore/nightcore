import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import type { PersistedTerminalInfo } from '@/lib/bridge';

import { TerminalReadonlyPane } from './TerminalReadonlyPane';
import type { TerminalReadonlyPaneProps } from './TerminalReadonlyPane.types';

const INFO: PersistedTerminalInfo = {
  id: 'restored-1',
  cwd: '/Users/dev/nightcore/.nightcore/worktrees/task-42',
  shell: '/bin/zsh',
  confined: false,
  createdAt: 0,
  updatedAt: 1,
  title: null,
  titleSource: null,
  ungoverned: false,
};

/** Sized host so the read-only xterm has geometry (outside Tauri the replay bytes
 *  are empty, so the pane shows its chrome + action over an empty terminal). */
function Fixture(props: TerminalReadonlyPaneProps) {
  return (
    <div style={{ height: 420, width: 720, display: 'flex' }}>
      <TerminalReadonlyPane {...props} />
    </div>
  );
}

const meta = {
  title: 'Terminal/TerminalReadonlyPane',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
  args: {
    info: INFO,
    canRestore: true,
    onRestore: fn(),
    onResumeClaude: fn(),
  },
} satisfies Meta<typeof Fixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The original folder still exists — the fresh-shell action is enabled. */
export const Restorable: Story = {};

/** The original folder was removed — the fresh-shell action is disabled with a hint. */
export const Vanished: Story = { args: { canRestore: false } };

/** Play test: the fresh-shell action fires onRestore when the folder still exists. */
export const StartsFreshShell: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: /Start a fresh shell here/i }));
    await expect(args.onRestore).toHaveBeenCalled();
  },
};

/** An ungoverned restored tab (#405): the persisted marker outlives the shell, so the
 *  read-only chrome still says an agent ran in that folder. */
export const Ungoverned: Story = {
  args: { info: { ...INFO, ungoverned: true } },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText('Ungoverned')).toBeInTheDocument();
  },
};

/** Play test (#405): a restored session's scrollback is searchable. The read-only
 *  replay has no focusable textarea to bubble ⌘F out of, so the pane carries a real
 *  Search button that opens the same find bar the live pane uses. */
export const SearchesRestoredScrollback: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: /^Search$/ }));
    await expect(canvas.getByLabelText('Search terminal scrollback')).toBeInTheDocument();
  },
};
