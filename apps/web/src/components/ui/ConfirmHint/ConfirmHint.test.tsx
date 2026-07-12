import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ConfirmHint.stories';

const { Default } = composeStories(stories);

test('renders the modifier + Enter pairing and its label', async () => {
  const screen = render(<Default />);
  // The ↵ chip and the platform modifier chip (⌘ on macOS, Ctrl elsewhere).
  await expect.element(screen.getByText('↵')).toBeVisible();
  await expect.element(screen.getByText(/^(⌘|Ctrl)$/)).toBeVisible();
  await expect.element(screen.getByText(/to confirm/)).toBeVisible();
});
