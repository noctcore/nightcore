import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { WorktreeInfo } from '@/lib/bridge';

// Mock the bridge so the cleanup interlock (spec PR 5c) is fully controllable:
// list returns one terminal worktree, sessions-in-dir returns one open session, and
// kill/discard are observable spies.
const TERM_WORKTREE: WorktreeInfo = {
  branch: 'term/spike',
  path: '/repo/.nightcore/worktrees-term/spike',
  taskIds: [],
  dirty: false,
  aheadOfBase: 0,
  behindOfBase: 0,
  changedFiles: 0,
};

const listTerminalWorktrees = vi.fn(() => Promise.resolve([TERM_WORKTREE]));
const discardTerminalWorktree = vi.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const killTerminal = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const terminalSessionsInDir = vi.fn(() =>
  Promise.resolve([
    {
      id: 's1',
      cwd: '/repo/.nightcore/worktrees-term/spike',
      shell: '/bin/zsh',
      confined: false,
      cols: 80,
      rows: 24,
      alive: true,
      createdAt: 0,
    },
  ]),
);

vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    listTerminalWorktrees: () => listTerminalWorktrees(),
    discardTerminalWorktree: (slug: string) => discardTerminalWorktree(slug),
    killTerminal: (id: string) => killTerminal(id),
    terminalSessionsInDir: () => terminalSessionsInDir(),
  };
});

import { useTerminalWorktrees } from './worktree-terminal';

type Model = ReturnType<typeof useTerminalWorktrees>;

function Harness({ modelRef }: { modelRef: { current: Model | null } }) {
  modelRef.current = useTerminalWorktrees();
  return null;
}

function renderHook() {
  const modelRef: { current: Model | null } = { current: null };
  render(
    <ToastProvider>
      <Harness modelRef={modelRef} />
    </ToastProvider>,
  );
  return modelRef;
}

afterEach(() => {
  listTerminalWorktrees.mockClear();
  discardTerminalWorktree.mockClear();
  killTerminal.mockClear();
  terminalSessionsInDir.mockClear();
});

test('loads the terminal worktrees on mount', async () => {
  const model = renderHook();
  await vi.waitFor(() => expect(model.current!.worktrees).toEqual([TERM_WORKTREE]));
});

test('discarding a terminal worktree with a live terminal surfaces the open-session count', async () => {
  const model = renderHook();
  await vi.waitFor(() => expect(model.current!.worktrees.length).toBe(1));

  model.current!.openDiscard(TERM_WORKTREE);

  // The interlock probes for open sessions in the worktree dir and surfaces them (the
  // DiscardDialog renders "N session(s) open" from this list).
  await vi.waitFor(() => expect(terminalSessionsInDir).toHaveBeenCalled());
  await vi.waitFor(() => expect(model.current!.discard?.terminalSessions).toEqual(['s1']));
});

test('confirm kills the worktree terminal sessions BEFORE discarding, keyed on the slug', async () => {
  const model = renderHook();
  await vi.waitFor(() => expect(model.current!.worktrees.length).toBe(1));

  model.current!.openDiscard(TERM_WORKTREE);
  await vi.waitFor(() => expect(model.current!.discard?.terminalSessions).toEqual(['s1']));

  model.current!.confirmDiscard();

  await vi.waitFor(() => expect(killTerminal).toHaveBeenCalledWith('s1'));
  // The slug is the worktree dir name (`spike`), not the path.
  await vi.waitFor(() => expect(discardTerminalWorktree).toHaveBeenCalledWith('spike'));
  expect(killTerminal.mock.invocationCallOrder[0]!).toBeLessThan(
    discardTerminalWorktree.mock.invocationCallOrder[0]!,
  );
});

test('with no open sessions, discard proceeds without killing anything', async () => {
  terminalSessionsInDir.mockResolvedValueOnce([]);
  const model = renderHook();
  await vi.waitFor(() => expect(model.current!.worktrees.length).toBe(1));

  model.current!.openDiscard(TERM_WORKTREE);
  await vi.waitFor(() => expect(model.current!.discard?.terminalSessions).toEqual([]));

  model.current!.confirmDiscard();
  await vi.waitFor(() => expect(discardTerminalWorktree).toHaveBeenCalledWith('spike'));
  expect(killTerminal).not.toHaveBeenCalled();
});
