import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

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

test('bare Enter does not confirm — Cancel has initial focus, so it cancels instead', async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const screen = render(<Destructive onConfirm={onConfirm} onCancel={onCancel} />);
  // Cancel (the safe action) takes initial focus, so a stray Enter can't confirm.
  await expect.element(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalled();
});

test('Cmd/Ctrl+Enter invokes onConfirm (the house confirm accelerator)', async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<Destructive onConfirm={onConfirm} onCancel={onCancel} />);
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  expect(onConfirm).toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

test('the footer hint shows the modifier + Enter confirm pairing', async () => {
  const screen = render(<Destructive />);
  // The ⌘/Ctrl + ↵ chips (platform-dependent modifier) plus the "to confirm" label —
  // no bare ↵ hint any more.
  await expect.element(screen.getByText('↵')).toBeInTheDocument();
  await expect.element(screen.getByText(/^(⌘|Ctrl)$/)).toBeInTheDocument();
  await expect.element(screen.getByText(/to confirm/)).toBeInTheDocument();
});
