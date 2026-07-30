import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ShortcutSheet.stories';

const { Closed, Default } = composeStories(stories);

test('lists every nav key with the stage its destination belongs to', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }))
    .toBeInTheDocument();

  // Derived from the live nav rows — the Understand stage's destination and its key.
  await expect.element(screen.getByText('Find & Grade', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Understand stage')).toBeInTheDocument();
  // The board layer and the house dialog rule are documented nowhere else.
  await expect.element(screen.getByText('New task', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Confirm', { exact: true })).toBeInTheDocument();
});

test('closes on Escape and from the close button', async () => {
  const onClose = vi.fn();
  const screen = render(<Default onClose={onClose} />);
  // Focus lands inside the dialog on open (shared Modal focus trap), so Esc reaches it.
  await screen.getByRole('button', { name: 'Close' }).click();
  expect(onClose).toHaveBeenCalled();

  onClose.mockClear();
  await userPressEscape();
  expect(onClose).toHaveBeenCalled();
});

async function userPressEscape(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await Promise.resolve();
}

test('renders nothing while closed', async () => {
  const screen = render(<Closed />);
  await expect
    .element(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }))
    .not.toBeInTheDocument();
});
