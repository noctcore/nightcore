import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './NavSidebar.stories';

const { Default } = composeStories(stories);

test('renders grouped workspace nav', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Kanban Board')).toBeInTheDocument();
  await expect.element(screen.getByText('Project')).toBeInTheDocument();
  await expect.element(screen.getByText('Understand')).toBeInTheDocument();
});

test('renders the Verify stage note under its items', async () => {
  const screen = render(<Default />);
  // The Verify group carries a muted, non-interactive caption (NAV_GROUP_META.note)
  // explaining that its surface — the Structure-Lock Gauntlet — runs on the board.
  await expect
    .element(screen.getByText('Structure-Lock Gauntlet runs per-task on the board.'))
    .toBeInTheDocument();
});
