import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './WorktreeManager.stories';

const { Default, Empty, Loading, Single, Orphaned, Diverged } = composeStories(stories);

test('renders the header with the worktree count', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Worktrees')).toBeInTheDocument();
  await expect.element(screen.getByText('3', { exact: true })).toBeInTheDocument();
});

test('shows an empty state when there are no worktrees', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText(/no active worktrees/i)).toBeInTheDocument();
});

test('shows a loading status while loading', async () => {
  const screen = render(<Loading />);
  await expect
    .element(screen.getByRole('status', { name: /loading worktrees/i }))
    .toBeInTheDocument();
});

test('fires onViewDiff with the primary task id', async () => {
  const onViewDiff = vi.fn();
  const screen = render(<Single onViewDiff={onViewDiff} />);
  await screen.getByRole('button', { name: /diff/i }).click();
  expect(onViewDiff).toHaveBeenCalledWith('task-7');
});

test('fires onPreviewMerge and onDiscard with the primary task id', async () => {
  const onPreviewMerge = vi.fn();
  const onDiscard = vi.fn();
  const screen = render(<Single onPreviewMerge={onPreviewMerge} onDiscard={onDiscard} />);
  await screen.getByRole('button', { name: /merge/i }).click();
  await screen.getByRole('button', { name: /discard/i }).click();
  expect(onPreviewMerge).toHaveBeenCalledWith('task-7');
  expect(onDiscard).toHaveBeenCalledWith('task-7');
});

test('disables actions for a worktree with no owning task', async () => {
  const screen = render(<Orphaned />);
  await expect.element(screen.getByRole('button', { name: /diff/i })).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: /merge/i })).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
});

test('flags a diverged worktree', async () => {
  const screen = render(<Diverged />);
  await expect.element(screen.getByLabelText(/diverged from base/i)).toBeInTheDocument();
});
