import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import * as stories from './ConfirmDialog.stories';

const { Destructive } = composeStories(stories);

test('renders the title and message', async () => {
  const screen = render(<Destructive />);
  await expect.element(screen.getByText('Remove project?')).toBeInTheDocument();
  await expect.element(screen.getByText(/files on disk are left untouched/i)).toBeInTheDocument();
});

test('confirm button invokes onConfirm', async () => {
  const onConfirm = vi.fn();
  const screen = render(<Destructive onConfirm={onConfirm} />);
  await screen.getByRole('button', { name: 'Remove' }).click();
  expect(onConfirm).toHaveBeenCalled();
});

test('Cancel invokes onCancel', async () => {
  const onCancel = vi.fn();
  const screen = render(<Destructive onCancel={onCancel} />);
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(onCancel).toHaveBeenCalled();
});

test('Escape invokes onCancel', async () => {
  const onCancel = vi.fn();
  render(<Destructive onCancel={onCancel} />);
  await userEvent.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalled();
});

test('Enter invokes onConfirm', async () => {
  const onConfirm = vi.fn();
  render(<Destructive onConfirm={onConfirm} />);
  await userEvent.keyboard('{Enter}');
  expect(onConfirm).toHaveBeenCalled();
});
