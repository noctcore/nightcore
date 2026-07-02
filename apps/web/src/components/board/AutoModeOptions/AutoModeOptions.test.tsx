import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './AutoModeOptions.stories';

const { Collapsed, Enabled } = composeStories(stories);

test('starts collapsed — no options panel until the gear is clicked', async () => {
  const screen = render(<Collapsed />);
  expect(screen.container.querySelector('[role="group"]')).toBeNull();
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .toBeInTheDocument();
});

test('toggling the switch reports the next value', async () => {
  const onAutoCommitChange = vi.fn();
  const screen = render(<Collapsed onAutoCommitChange={onAutoCommitChange} />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await screen.getByRole('switch', { name: /auto-commit on verified/i }).click();
  expect(onAutoCommitChange).toHaveBeenCalledWith(true);
});

test('reflects the enabled option as aria-checked', async () => {
  const screen = render(<Enabled />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .toHaveAttribute('aria-checked', 'true');
});
