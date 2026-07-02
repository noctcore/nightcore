import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './MergePreviewDialog.stories';

const { Ready, UpToDate, Diverged, Conflicts, Loading, Merging } = composeStories(stories);

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
  await expect.element(screen.getByText('main')).toBeInTheDocument();
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
  await expect.element(screen.getByText('apps/web/src/store/types.ts')).toBeInTheDocument();
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
