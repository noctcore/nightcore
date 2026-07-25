import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './MergePreviewDialog.stories';

const {
  Ready,
  UpToDate,
  Diverged,
  Conflicts,
  Loading,
  Merging,
  UpdatingFromBase,
  WithTerminalSessions,
} = composeStories(stories);

test('enables Merge and fires onMerge for a ready preview', async () => {
  const onMerge = vi.fn();
  const screen = render(<Ready onMerge={onMerge} />);
  const merge = screen.getByRole('button', { name: 'Merge' });
  await expect.element(merge).toBeEnabled();
  await merge.click();
  expect(onMerge).toHaveBeenCalled();
});

test('shows the branch → base target and stats row', async () => {
  const screen = render(<Ready />);
  await expect.element(screen.getByText('feat/merge-preview')).toBeInTheDocument();
  // Exact match targets the header's base span specifically — the merge-checkout
  // note now also contains the word "main", so a substring match is ambiguous.
  await expect.element(screen.getByText('main', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText(/2 files,/)).toBeInTheDocument();
  await expect.element(screen.getByText(/3 ahead \/ 0 behind/)).toBeInTheDocument();
});

test('disables Merge when already up to date', async () => {
  const screen = render(<UpToDate />);
  await expect.element(screen.getByText(/Already up to date/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
});

test('surfaces the behind count when diverged but still allows merge', async () => {
  const screen = render(<Diverged />);
  await expect.element(screen.getByText(/Branch diverged \(7 behind\)/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
});

test('blocks merge and lists conflict files when conflicting', async () => {
  const screen = render(<Conflicts />);
  await expect.element(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  await expect
    .element(screen.getByText(/2 conflicts — resolve before merging/i))
    .toBeInTheDocument();
  // Conflict paths are split into a truncatable dir prefix + always-visible leaf,
  // so the full path lives on the row's title rather than in one text node.
  await expect.element(screen.getByTitle('apps/web/src/store/types.ts')).toBeInTheDocument();
});

test('shows the conflict-check copy while loading', async () => {
  const screen = render(<Loading />);
  await expect.element(screen.getByText(/Checking for conflicts…/i)).toBeInTheDocument();
});

test('shows the merging state and disables Merge while in flight', async () => {
  const screen = render(<Merging />);
  await expect.element(screen.getByText(/Merging…/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /Merging…/i })).toBeDisabled();
});

test('fires onClose from the close affordance', async () => {
  const onClose = vi.fn();
  const screen = render(<Ready onClose={onClose} />);
  await screen.getByRole('button', { name: 'Close' }).click();
  expect(onClose).toHaveBeenCalled();
});

test('warns when live terminal sessions are open in the worktree', async () => {
  const screen = render(<WithTerminalSessions />);
  await expect
    .element(screen.getByText(/3 terminal sessions open in this worktree will be closed\./i))
    .toBeInTheDocument();
});

test('shows no terminal-session notice when none are open', async () => {
  const screen = render(<Ready />);
  await expect
    .element(screen.getByText(/terminal sessions? open/i))
    .not.toBeInTheDocument();
});

test('raises the stale-branch hazard callout when behind base', async () => {
  const screen = render(<Diverged />);
  await expect.element(screen.getByText(/7 commits behind main/i)).toBeInTheDocument();
  await expect
    .element(screen.getByText(/Merging may silently revert base-only changes/i))
    .toBeInTheDocument();
});

test('shows no hazard callout for a clean ahead-only branch', async () => {
  const screen = render(<Ready />);
  await expect.element(screen.getByText(/behind main/i)).not.toBeInTheDocument();
});

test('offers Update from base when behind, and fires onUpdateFromBase', async () => {
  const onUpdateFromBase = vi.fn();
  const screen = render(<Diverged onUpdateFromBase={onUpdateFromBase} />);
  const update = screen.getByRole('button', { name: /Update from base/i });
  await expect.element(update).toBeEnabled();
  await update.click();
  expect(onUpdateFromBase).toHaveBeenCalled();
});

test('hides Update from base when the branch is not behind base', async () => {
  const screen = render(<Ready />);
  await expect
    .element(screen.getByRole('button', { name: /Update from base/i }))
    .not.toBeInTheDocument();
});

test('disables Update from base and shows the spinner label while updating', async () => {
  const screen = render(<UpdatingFromBase />);
  await expect.element(screen.getByText(/Updating…/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /Updating…/i })).toBeDisabled();
});

test('shows the merge-checkout note naming the real base for a mergeable preview', async () => {
  const screen = render(<Ready />);
  await expect
    .element(screen.getByText(/Merging checks out main in the main repo and leaves it there\./i))
    .toBeInTheDocument();
});

test('hides the merge-checkout note when the merge would conflict', async () => {
  const screen = render(<Conflicts />);
  await expect.element(screen.getByText(/Merging checks out/i)).not.toBeInTheDocument();
});
