import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './RunControls.stories';

const { Default, Empty } = composeStories(stories);

test('fires onScan when the Scan CTA is pressed with lenses selected', async () => {
  const onScan = vi.fn();
  const screen = render(<Default onScan={onScan} />);
  await screen.getByRole('button', { name: /^scan$/i }).click();
  expect(onScan).toHaveBeenCalledTimes(1);
});

test('disables Scan when no lens is selected', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByRole('button', { name: /^scan$/i })).toBeDisabled();
});

test('toggling a lens chip fires onToggle with its category', async () => {
  const onToggle = vi.fn();
  const screen = render(<Default onToggle={onToggle} />);
  await screen.getByRole('button', { name: /Architecture/ }).click();
  expect(onToggle).toHaveBeenCalledWith('architecture');
});

test('the None shortcut clears the selection via onSelectNone', async () => {
  const onSelectNone = vi.fn();
  const screen = render(<Default onSelectNone={onSelectNone} />);
  await screen.getByRole('button', { name: /^none$/i }).click();
  expect(onSelectNone).toHaveBeenCalledTimes(1);
});
