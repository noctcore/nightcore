import { composeStories } from '@storybook/react-vite';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { TerminalSessionInfo } from '@/lib/bridge';

// Mock the session manager so the tab lifecycle is driven WITHOUT a real xterm /
// PTY: `openSession` is controllable (resolve → a tab, reject → the cap error),
// and attach is a no-op so the pane renders its chrome only.
const openSessionMock = vi.fn<(opts: unknown) => Promise<TerminalSessionInfo>>();
const closeSessionMock = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../terminal-session-manager', () => ({
  openSession: (opts: unknown) => openSessionMock(opts),
  closeSession: (id: string) => closeSessionMock(id),
  attachSession: () => () => {},
  hasSession: () => true,
  reconcileSessions: () => {},
}));

// Keep the real bridge (ToastProvider, types) but pin `listTerminals` to empty so
// the view starts with no tabs.
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return { ...actual, listTerminals: () => Promise.resolve([]) };
});

import * as stories from './TerminalView.stories';

const { Empty } = composeStories(stories);

function fakeSession(id: string, cwd: string): TerminalSessionInfo {
  return {
    id,
    cwd,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: 0,
  };
}

afterEach(() => {
  openSessionMock.mockReset();
  closeSessionMock.mockClear();
});

test('shows the empty state until a terminal is opened', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No terminals open')).toBeInTheDocument();
});

test('opening a target spawns a tab, activates it, and closes the picker', async () => {
  openSessionMock.mockResolvedValueOnce(
    fakeSession('s1', '/Users/dev/nightcore/.nightcore/worktrees/t1'),
  );
  const screen = render(<Empty />);

  await screen.getByRole('button', { name: 'Open a terminal' }).click();
  await screen.getByRole('button', { name: /nc\/api-client/ }).click();

  // The new tab and its pane's identity chrome appear.
  await expect.element(screen.getByRole('tab', { name: /t1/ })).toBeInTheDocument();
  await expect.element(screen.getByText('Your shell — unconfined')).toBeInTheDocument();
  expect(openSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/Users/dev/nightcore/.nightcore/worktrees/t1', confined: false }),
  );
});

test('a spawn beyond the cap surfaces inline and does NOT crash the picker', async () => {
  openSessionMock.mockRejectedValueOnce(
    'terminal session limit reached (8) — close a tab first',
  );
  const screen = render(<Empty />);

  await screen.getByRole('button', { name: 'Open a terminal' }).click();
  await screen.getByRole('button', { name: /nc\/api-client/ }).click();

  // The picker stays open with the error; the repo/worktree targets are still there.
  await expect
    .element(screen.getByText(/terminal session limit reached \(8\)/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /nc\/auth-guard/ }))
    .toBeInTheDocument();
});

test('closing a tab confirms, then kills the session and returns to empty', async () => {
  openSessionMock.mockResolvedValueOnce(
    fakeSession('s1', '/Users/dev/nightcore/.nightcore/worktrees/t1'),
  );
  const screen = render(<Empty />);

  await screen.getByRole('button', { name: 'Open a terminal' }).click();
  await screen.getByRole('button', { name: /nc\/api-client/ }).click();
  await expect.element(screen.getByRole('tab', { name: /t1/ })).toBeInTheDocument();

  await screen.getByRole('button', { name: /Close t1/ }).click();
  // The confirm gate (confirm-if-alive) blocks the kill until confirmed.
  await expect.element(screen.getByText('Close terminal?')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Close terminal' }).click();

  expect(closeSessionMock).toHaveBeenCalledWith('s1');
  await expect.element(screen.getByText('No terminals open')).toBeInTheDocument();
});
