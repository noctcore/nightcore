import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './WorktreeView.stories';

const { Default, Empty } = composeStories(stories);

test('lists the project worktrees', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('nc/api-client')).toBeInTheDocument();
  await expect.element(screen.getByText('nc/auth-guard')).toBeInTheDocument();
});

test('shows an empty state when there are no worktrees', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No active worktrees')).toBeInTheDocument();
});
