import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './AppShell.stories';

const { Default } = composeStories(stories);

test('renders the sidebar nav and the active project from mock data', async () => {
  const screen = render(<Default />);
  // Sidebar nav items — query by the nav button (its accessible name is the label +
  // Kbd hint), not by text: "Kanban Board" also appears as the Board's own <h1>, so a
  // bare getByText is ambiguous once the active project loads and both mount.
  await expect
    .element(screen.getByRole('button', { name: /^Kanban Board K$/ }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^Settings S$/ }))
    .toBeInTheDocument();
  // The mock active project surfaces in the switcher.
  await expect.element(screen.getByText('nightcore').first()).toBeInTheDocument();
});

test('the sidebar brand returns to the full-screen Projects surface', async () => {
  const screen = render(<Default />);
  // Projects is no longer a nav item — the brand/logo is its entry point, and the
  // surface renders full-screen (the sidebar is hidden there).
  await screen.getByRole('button', { name: /back to projects/i }).click();
  await expect
    .element(
      screen.getByText('Each project is a git repo with its own board & settings.'),
    )
    .toBeInTheDocument();
});

test('routes to the Settings surface and shows the run-shaping controls', async () => {
  const screen = render(<Default />);
  await screen.getByRole('button', { name: /^Settings S$/ }).click();
  // The Models & runs page header and its live default-model control.
  await expect
    .element(screen.getByRole('heading', { name: 'Models & runs', level: 1 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Opus' }))
    .toBeInTheDocument();
});
