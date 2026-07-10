import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Seed one board task carrying a legacy `insight:` provenance token so the
// integration test below can exercise the full token → REGISTRY → union →
// render-branch chain (the blank-screen tripwire). Everything else stays the real
// browser-mode bridge; only `listTasks` is overridden. The factory is hoisted
// above imports, so `makeTask` is pulled in via a dynamic import inside it.
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  const { makeTask } = await import('@/components/board/_fixtures');
  return {
    ...actual,
    listTasks: async () => [
      makeTask({
        id: 'task-prov',
        title: 'Adopt the folder-per-component convention',
        sourceRef: 'insight:run-1:f-1',
      }),
    ],
  };
});

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

test('a legacy insight provenance chip routes through to the Understand surface', async () => {
  // The full compat chain, end to end: a persisted `insight:` sourceRef → the
  // retargeted source-ref REGISTRY (`view: 'understand'`) → the shrunk AppView
  // union → the `view === 'understand'` render branch. If any link broke (the
  // blank-screen mode), the Understand shell would never mount.
  const screen = render(<Default />);
  // Open the seeded task's drawer from its board card.
  await screen
    .getByRole('button', { name: /Adopt the folder-per-component convention/ })
    .click();
  // Wait for the drawer to mount, then fire the provenance chip's routing click.
  // A native element click sidesteps the board↔drawer slide-in hit-test overlap
  // (the chip's onClick is a plain handler React catches via event delegation).
  const chip = screen.getByRole('button', { name: /From Insight finding/ });
  await expect.element(chip).toBeInTheDocument();
  (chip.element() as HTMLElement).click();
  // The Understand stage shell mounted (its Find | Grade toggle group) — proof the
  // token → REGISTRY → union → render-branch chain resolved (no blank screen).
  await expect
    .element(screen.getByRole('group', { name: 'Understand lens' }))
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
    .element(screen.getByRole('combobox', { name: 'Default model' }))
    .toBeInTheDocument();
});
