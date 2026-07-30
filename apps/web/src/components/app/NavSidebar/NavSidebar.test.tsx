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

test('each stage header discloses what the stage means', async () => {
  const screen = render(<Default />);
  const toggle = screen.getByRole('button', {
    name: 'Show what the Understand stage means',
  });
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  // The explainer copy comes from the shared lifecycle table (`@/lib/stages`) — the
  // same source the onboarding stage diagram renders.
  await expect
    .element(screen.getByText('Grounded findings and a repo scorecard', { exact: false }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Hide what the Understand stage means' }))
    .toHaveAttribute('aria-expanded', 'true');
});

test('renders the Verify stage note under its items', async () => {
  const screen = render(<Default />);
  // The Verify group carries a muted, non-interactive caption (NAV_GROUP_META.note)
  // explaining that its surface — the Structure-Lock Gauntlet — runs on the board.
  await expect
    .element(screen.getByText('Structure-Lock Gauntlet runs per-task on the board.'))
    .toBeInTheDocument();
});
