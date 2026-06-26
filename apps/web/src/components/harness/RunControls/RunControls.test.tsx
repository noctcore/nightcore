import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './RunControls.stories';

const { Default } = composeStories(stories);

test('fires onScan when the Scan CTA is pressed with lenses selected', async () => {
  const onScan = vi.fn();
  const screen = render(<Default onScan={onScan} />);
  // Default hint reflects all eight lenses selected.
  await expect.element(screen.getByText(/across 8 lenses/i)).toBeInTheDocument();
  await screen.getByRole('button', { name: /^scan$/i }).click();
  expect(onScan).toHaveBeenCalledTimes(1);
});

test('clearing the selection disables Scan', async () => {
  const screen = render(<Default />);
  await screen.getByRole('button', { name: /^none$/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /^scan$/i }))
    .toBeDisabled();
});

test('toggling a lens off updates the lens count hint', async () => {
  const screen = render(<Default />);
  await screen.getByRole('button', { name: /Architecture/ }).click();
  await expect.element(screen.getByText(/across 7 lenses/i)).toBeInTheDocument();
});
