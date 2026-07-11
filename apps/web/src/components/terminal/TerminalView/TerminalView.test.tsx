import { composeStories } from '@storybook/react-vite';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

// Mock the session manager so the tab lifecycle is driven WITHOUT a real xterm /
// PTY: `openSession` is controllable (resolve → a tab, reject → the cap error),
// and attach / renderer are no-ops so the pane renders its chrome only.
const openSessionMock = vi.fn<(opts: unknown) => Promise<TerminalSessionInfo>>();
const closeSessionMock = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../terminal-session-manager', () => ({
  openSession: (opts: unknown) => openSessionMock(opts),
  closeSession: (id: string) => closeSessionMock(id),
  attachSession: () => () => {},
  ensureRenderer: () => Promise.resolve(),
  hasSession: () => true,
  // Daemon reattach seam (PR 6): never exercised here (hasSession → true makes the
  // mount reattach loop empty), but the hook imports it, so the mock must export it.
  reattachSession: () => Promise.resolve({} as TerminalSessionInfo),
  reconcileSessions: () => {},
  // Activity-badge seam (decision 6c): the hook subscribes + reads counts. The
  // subscription returns an unsubscribe; counts are 0 (no real output in tests).
  subscribeActivity: () => () => {},
  getUnread: () => 0,
  clearUnread: () => {},
  setActiveTerminal: () => {},
  // Layout seam (PR 2): the visible-set + refit calls the layout hook makes.
  setVisibleTerminals: () => {},
  refitSession: () => {},
  // Search seam (PR 3c): the find bar drives these per session; no real xterm here.
  searchNext: () => false,
  searchPrevious: () => false,
  clearSearch: () => {},
  focusSession: () => {},
  // Render-prefs seam (PR 3d): the view pushes font/scrollback to live terminals.
  applyRenderPrefs: () => {},
}));

// Keep the real bridge (ToastProvider, types, getAppInfo → macOS mock) but make the
// terminal listings controllable so restore + empty flows are driven per test.
const listTerminalsMock = vi.fn<() => Promise<TerminalSessionInfo[]>>(() => Promise.resolve([]));
const listPersistedMock = vi.fn<() => Promise<PersistedTerminalInfo[]>>(() => Promise.resolve([]));
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    listTerminals: () => listTerminalsMock(),
    listTerminalsPersisted: () => listPersistedMock(),
    deleteTerminalPersisted: () => Promise.resolve(),
    // The restore fresh-shell gate now probes existence (a cwd can be ANY browsed
    // dir, not just a worktree). Here the `t1` cwd still exists, the `removed` one
    // does not — driving the enabled/disabled restore action per tab.
    directoryExists: (path: string) => Promise.resolve(path.endsWith('/t1')),
    readTerminalPersisted: (id: string) =>
      Promise.resolve({
        info: { id, cwd: '', shell: '', confined: false, createdAt: 0, updatedAt: 0, title: null },
        dataBase64: '',
      }),
  };
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
    title: null,
  };
}

function persisted(id: string, cwd: string): PersistedTerminalInfo {
  return { id, cwd, shell: '/bin/zsh', confined: false, createdAt: 0, updatedAt: 1, title: null };
}

afterEach(() => {
  openSessionMock.mockReset();
  closeSessionMock.mockClear();
  listTerminalsMock.mockReset();
  listTerminalsMock.mockResolvedValue([]);
  listPersistedMock.mockReset();
  listPersistedMock.mockResolvedValue([]);
  // These tests exercise the default (tabs) view mode; clear any layout blob a case
  // might persist so the next case starts in tabs mode.
  window.localStorage.removeItem('nc:terminal:layout');
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

test('checking Confined spawns confined; a fail-closed refusal surfaces inline', async () => {
  const screen = render(<Empty />);

  await screen.getByRole('button', { name: 'Open a terminal' }).click();
  // macOS host (getAppInfo mock → os: 'macos'), so the confined checkbox renders.
  await screen.getByText(/Confined \(writes limited to this folder\)/i).click();

  // First: the fail-closed refusal path surfaces inline without closing the picker.
  openSessionMock.mockRejectedValueOnce(
    'refusing the confined spawn — its Seatbelt profile could not be assembled',
  );
  await screen.getByRole('button', { name: /nc\/api-client/ }).click();
  await expect
    .element(screen.getByText(/Seatbelt profile could not be assembled/i))
    .toBeInTheDocument();
  expect(openSessionMock).toHaveBeenLastCalledWith(expect.objectContaining({ confined: true }));

  // Then: a successful confined spawn opens a confined tab.
  openSessionMock.mockResolvedValueOnce({
    ...fakeSession('c1', '/Users/dev/nightcore/.nightcore/worktrees/t1'),
    confined: true,
  });
  await screen.getByRole('button', { name: /nc\/api-client/ }).click();
  await expect.element(screen.getByText('Confined to this worktree')).toBeInTheDocument();
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

test('restores a persisted session read-only; fresh-shell is gated on the cwd still existing', async () => {
  // A persisted session whose cwd STILL EXISTS (restorable) and one whose cwd was
  // removed (probe → false → the fresh-shell action is disabled with a hint).
  listPersistedMock.mockResolvedValue([
    persisted('r1', '/Users/dev/nightcore/.nightcore/worktrees/t1'),
    persisted('gone', '/Users/dev/nightcore/.nightcore/worktrees/removed'),
  ]);
  const screen = render(<Empty />);

  // The restored tab replays read-only (no live sessions, so it is active on mount).
  await expect.element(screen.getByText('Session ended — read-only')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /Start a fresh shell here/i }))
    .toBeEnabled();

  // Starting a fresh shell spawns a live session in the restored cwd.
  openSessionMock.mockResolvedValueOnce(
    fakeSession('fresh', '/Users/dev/nightcore/.nightcore/worktrees/t1'),
  );
  await screen.getByRole('button', { name: /Start a fresh shell here/i }).click();
  expect(openSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/Users/dev/nightcore/.nightcore/worktrees/t1' }),
  );

  // The removed-cwd restored tab's action is disabled (its worktree is gone).
  await screen.getByRole('tab', { name: /removed/ }).click();
  await expect
    .element(screen.getByRole('button', { name: /Start a fresh shell here/i }))
    .toBeDisabled();
});

test('Browse opens the folder browser and spawns in the chosen directory', async () => {
  openSessionMock.mockResolvedValueOnce(fakeSession('b1', '/Users/dev/nightcore'));
  const screen = render(<Empty />);

  await screen.getByRole('button', { name: 'Open a terminal' }).click();
  // The picker offers a Browse entry alongside the repo root + worktrees.
  await screen.getByRole('button', { name: /Browse/ }).click();

  // The folder browser opens at the project root (empty in the mock fs); selecting
  // the current folder spawns a shell there.
  await expect
    .element(screen.getByRole('heading', { name: 'Open a terminal here' }))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /Open terminal here/i }).click();

  expect(openSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/Users/dev/nightcore', confined: false }),
  );
});
