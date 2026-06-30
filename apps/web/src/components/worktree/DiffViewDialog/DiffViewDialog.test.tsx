import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './DiffViewDialog.stories';

const { Default, Empty, Loading } = composeStories(stories);

test('lists the changed file paths', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('apps/web/src/components/board/Board/Board.tsx'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('scratch/notes.md')).toBeInTheDocument();
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
