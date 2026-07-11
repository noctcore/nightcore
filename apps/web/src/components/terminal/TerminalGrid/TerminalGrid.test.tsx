import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalGrid } from './TerminalGrid';

function session(id: string, over: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id,
    cwd: `/Users/dev/nightcore/.nightcore/worktrees/${id}`,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: 0,
    title: null,
    titleSource: null,
    ...over,
  };
}

function renderGrid(sessions: TerminalSessionInfo[], zoomedId: string | null = null) {
  return render(
    <ToastProvider>
      <TerminalGrid
        sessions={sessions}
        unread={{}}
        ungovernedIds={new Set()}
        canLaunchClaude={() => true}
        zoomedId={zoomedId}
        onRename={() => {}}
        onLaunchClaude={() => {}}
        onReorder={() => {}}
        onToggleZoom={() => {}}
        onActivate={() => {}}
      />
    </ToastProvider>,
  );
}

test('renders one pane per session with count-driven columns', async () => {
  const screen = renderGrid([session('a'), session('b'), session('c')]);
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-session-id]')).toHaveLength(3),
  );
  // 3 sessions → 2 columns (≤4 → 2×2). The browser normalizes `minmax(0` to
  // `minmax(0px`, so assert the column COUNT, not the exact normalized string.
  const grid = screen.container.querySelector<HTMLElement>('div.grid');
  expect(grid?.style.gridTemplateColumns).toMatch(/^repeat\(2,/);
});

test('reordering keyed panes does NOT unmount them (same DOM node persists)', async () => {
  const screen = renderGrid([session('a'), session('b')]);
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-session-id="a"]')).not.toBeNull(),
  );
  const before = screen.container.querySelector('[data-session-id="a"]');

  // Parent reorders the list (b before a) — the flat keyed grid must reuse, not
  // recreate, pane `a`'s DOM subtree (the xterm host must never be re-parented).
  screen.rerender(
    <ToastProvider>
      <TerminalGrid
        sessions={[session('b'), session('a')]}
        unread={{}}
        ungovernedIds={new Set()}
        canLaunchClaude={() => true}
        zoomedId={null}
        onRename={() => {}}
        onLaunchClaude={() => {}}
        onReorder={() => {}}
        onToggleZoom={() => {}}
        onActivate={() => {}}
      />
    </ToastProvider>,
  );

  const after = screen.container.querySelector('[data-session-id="a"]');
  expect(after).toBe(before);
  expect(screen.container.querySelectorAll('[data-session-id]')).toHaveLength(2);
});

test('zooming a pane replaces the grid with only that pane', async () => {
  const screen = renderGrid([session('a'), session('b'), session('c')]);
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-session-id]')).toHaveLength(3),
  );

  screen.rerender(
    <ToastProvider>
      <TerminalGrid
        sessions={[session('a'), session('b'), session('c')]}
        unread={{}}
        ungovernedIds={new Set()}
        canLaunchClaude={() => true}
        zoomedId="b"
        onRename={() => {}}
        onLaunchClaude={() => {}}
        onReorder={() => {}}
        onToggleZoom={() => {}}
        onActivate={() => {}}
      />
    </ToastProvider>,
  );

  const panes = screen.container.querySelectorAll('[data-session-id]');
  expect(panes).toHaveLength(1);
  expect(panes[0]?.getAttribute('data-session-id')).toBe('b');
});

test('threads a per-pane Launch Claude affordance and fires it with the pane session', async () => {
  const onLaunchClaude = vi.fn();
  const screen = render(
    <ToastProvider>
      <TerminalGrid
        sessions={[session('a'), session('b')]}
        unread={{}}
        ungovernedIds={new Set()}
        canLaunchClaude={(s) => s.id === 'a'}
        zoomedId={null}
        onRename={() => {}}
        onLaunchClaude={onLaunchClaude}
        onReorder={() => {}}
        onToggleZoom={() => {}}
        onActivate={() => {}}
      />
    </ToastProvider>,
  );
  // Only the POSIX pane ('a') exposes the launch affordance.
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[aria-label="Launch Claude"]')).toHaveLength(1),
  );
  const launch = screen.container.querySelector<HTMLButtonElement>('[aria-label="Launch Claude"]');
  launch?.click();
  expect(onLaunchClaude).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
});
