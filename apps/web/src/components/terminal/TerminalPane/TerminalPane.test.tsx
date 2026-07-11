import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { closeSession, openSession } from '../terminal-session-manager';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../terminal-shared';
import { TerminalPane } from './TerminalPane';
import * as stories from './TerminalPane.stories';

const { Unconfined, Confined, Renamed } = composeStories(stories);

// Live sessions opened by a test are disposed here so the module-level manager
// cache doesn't leak an xterm across tests.
let openedId: string | null = null;
afterEach(async () => {
  if (openedId !== null) {
    await closeSession(openedId);
    openedId = null;
  }
});

test('renders the unconfined identity chrome, shell, and cwd', async () => {
  const screen = render(<Unconfined />);
  await expect.element(screen.getByText('Your shell — unconfined')).toBeInTheDocument();
  await expect.element(screen.getByText('/bin/zsh')).toBeInTheDocument();
  await expect.element(screen.getByText('/Users/dev/nightcore')).toBeInTheDocument();
  // The write-containment hint is confined-only — absent on an unconfined tab.
  expect(screen.container.textContent).not.toContain('some shell-startup noise is normal');
});

test('renders the confined chrome variant with the write-containment hint', async () => {
  const screen = render(<Confined />);
  await expect.element(screen.getByText('Confined to this worktree')).toBeInTheDocument();
  await expect
    .element(
      screen.getByText(
        'Writes outside this folder are blocked — some shell-startup noise is normal.',
      ),
    )
    .toBeInTheDocument();
});

test('attaches a live xterm instance for a real (echo) session', async () => {
  // Outside Tauri the manager spawns against the in-memory echo bridge, so this
  // exercises openSession → attach (real xterm.open) end to end.
  const session: TerminalSessionInfo = await openSession({
    cwd: '/Users/dev/nightcore',
    confined: false,
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  });
  openedId = session.id;

  render(
    <ToastProvider>
      <TerminalPane
        session={session}
        isDropTarget={false}
        onRename={() => {}}
        link={{
          ungoverned: false,
          linkedTitle: null,
          canLaunchClaude: false,
          onLaunchClaude: () => {},
          onClearLink: () => {},
        }}
      />
    </ToastProvider>,
  );
  // The pane's attach effect opens the terminal into its container — the xterm
  // screen element appears once mounted.
  await vi.waitFor(() => expect(document.querySelector('.xterm')).not.toBeNull());
});

test('double-clicking the header title opens the inline rename and commits on Enter', async () => {
  const onRename = vi.fn();
  const screen = render(<Renamed onRename={onRename} />);
  await userEvent.dblClick(screen.getByText('deploy shell').element());
  const input = screen.getByRole('textbox', { name: /Rename/ });
  await input.fill('build shell');
  await userEvent.keyboard('{Enter}');
  expect(onRename).toHaveBeenCalledWith('story-session', 'build shell');
});
