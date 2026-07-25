import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the per-file diff fetch so an expanded row renders a real patch (the
// browser has no Tauri, where the bridge would otherwise fall back to '').
const worktreeFileDiff = vi.fn((_id: string, path: string) =>
  Promise.resolve(
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,2 +1,2 @@',
      '-const old = 1;',
      '+const next = 2;',
    ].join('\n'),
  ),
);
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return { ...actual, worktreeFileDiff: (id: string, path: string) => worktreeFileDiff(id, path) };
});

import * as stories from './DiffViewDialog.stories';

const { Default, Empty, Loading } = composeStories(stories);

const BOARD_PATH = 'apps/web/src/components/board/Board/Board.tsx';

test('lists the changed file paths', async () => {
  const screen = render(<Default />);
  // The path is split into a truncatable dir prefix and an always-visible leaf, so
  // the full path lives on the row's title rather than in one text node.
  await expect.element(screen.getByTitle(BOARD_PATH)).toBeInTheDocument();
  await expect.element(screen.getByTitle('scratch/notes.md')).toBeInTheDocument();
});

test('shows the diff summary line', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('5 files changed, 135 insertions(+), 52 deletions(-)'))
    .toBeInTheDocument();
});

test('renders the empty state when there are no files', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No changed files')).toBeInTheDocument();
});

test('fires onClose when the close button is clicked', async () => {
  const onClose = vi.fn();
  const screen = render(<Default onClose={onClose} />);
  await screen.getByRole('button', { name: /close/i }).click();
  expect(onClose).toHaveBeenCalled();
});

test('shows a spinner and no files while loading', async () => {
  const screen = render(<Loading />);
  await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.container.querySelector('ul')).toBeNull();
});

test('expands a file row to show its lazily-fetched patch', async () => {
  const screen = render(<Default taskId="t1" />);
  const row = screen.getByRole('button', { name: /Board\.tsx/ });
  await expect.element(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect.element(row).toHaveAttribute('aria-expanded', 'true');
  await expect.element(screen.getByText('+const next = 2;')).toBeInTheDocument();
  await expect.element(screen.getByText('-const old = 1;')).toBeInTheDocument();
  expect(worktreeFileDiff).toHaveBeenCalledWith('t1', BOARD_PATH);
});

test('collapses the open row on a second click', async () => {
  const screen = render(<Default taskId="t1" />);
  const row = screen.getByRole('button', { name: /Board\.tsx/ });
  await row.click();
  await expect.element(screen.getByText('+const next = 2;')).toBeInTheDocument();
  await row.click();
  await expect.element(row).toHaveAttribute('aria-expanded', 'false');
});
