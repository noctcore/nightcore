import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './ImageDropzone.stories';

const { Empty, WithItems, AtLimit, ReadOnly } = composeStories(stories);

test('the empty zone invites drop/paste/browse', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByRole('button', { name: /add images/i }))
    .toBeInTheDocument();
});

test('renders a thumbnail per item with a remove control', async () => {
  const screen = render(<WithItems />);
  await expect.element(screen.getByRole('img', { name: /screenshot\.png/i })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /remove screenshot\.png/i }))
    .toBeInTheDocument();
});

test('fires onRemove with the item id', async () => {
  const onRemove = vi.fn();
  const screen = render(<WithItems onRemove={onRemove} />);
  await screen.getByRole('button', { name: /remove mock\.png/i }).click();
  expect(onRemove).toHaveBeenCalledWith('b');
});

test('disables the add zone at the image limit', async () => {
  const screen = render(<AtLimit />);
  await expect.element(screen.getByRole('button', { name: /add images/i })).toBeDisabled();
});

test('read-only hides the add zone and remove buttons', async () => {
  const screen = render(<ReadOnly />);
  // The add zone button is gone…
  expect(screen.getByRole('button', { name: /add images/i }).query()).toBeNull();
  // …and so are the per-item remove buttons.
  expect(screen.getByRole('button', { name: /remove/i }).query()).toBeNull();
  // The thumbnails still render.
  await expect.element(screen.getByRole('img', { name: /screenshot\.png/i })).toBeInTheDocument();
});
