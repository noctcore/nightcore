import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './DiscardDialog.stories';

const { Default, NoBranch, WithUncommittedChanges, Discarding, WithError } =
  composeStories(stories);

test('renders the title and consequence copy with the branch name', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Discard worktree')).toBeInTheDocument();
  await expect.element(screen.getByText('feature/login')).toBeInTheDocument();
  await expect.element(screen.getByText(/deletes its\s+branch/i)).toBeInTheDocument();
});

test('falls back to "this task" when no branch is given', async () => {
  const screen = render(<NoBranch />);
  await expect.element(screen.getByText('this task')).toBeInTheDocument();
});

test('confirm button invokes onConfirm without closing', async () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const screen = render(<Default onConfirm={onConfirm} onClose={onClose} />);
  await screen.getByRole('button', { name: 'Discard' }).click();
  expect(onConfirm).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('Cancel invokes onClose', async () => {
  const onClose = vi.fn();
  const screen = render(<Default onClose={onClose} />);
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(onClose).toHaveBeenCalled();
});

test('shows the amber data-loss warning when files are uncommitted', async () => {
  const screen = render(<WithUncommittedChanges />);
  await expect
    .element(screen.getByText(/3 uncommitted file\(s\) will be lost\./i))
    .toBeInTheDocument();
});

test('disables the confirm button and shows the spinner label while discarding', async () => {
  const screen = render(<Discarding />);
  await expect.element(screen.getByRole('button', { name: /discarding/i })).toBeDisabled();
});

test('surfaces the error and flips the confirm button to Retry', async () => {
  const onConfirm = vi.fn();
  const screen = render(<WithError onConfirm={onConfirm} />);
  await expect.element(screen.getByText('fatal: worktree is locked')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Retry' }).click();
  expect(onConfirm).toHaveBeenCalled();
});
