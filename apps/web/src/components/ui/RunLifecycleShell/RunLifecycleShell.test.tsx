import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { RunLifecycleShell } from './RunLifecycleShell';
import * as stories from './RunLifecycleShell.stories';

const { Configure, Running, Minimal } = composeStories(stories);

test('hides the collapsed summary bar in the configure phase', async () => {
  const screen = render(<Configure />);
  await expect.element(screen.getByText('Harness')).toBeVisible();
  expect(screen.container.textContent).not.toContain('8 lenses');
});

test('shows the collapsed summary bar once running', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText(/8 lenses/)).toBeVisible();
});

test('renders the title, subtitle, and children', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('Harness')).toBeVisible();
  await expect.element(screen.getByText('nightcore')).toBeVisible();
  await expect.element(screen.getByText(/Screen body goes here/)).toBeVisible();
});

test('omits the summary bar when no summary is supplied', async () => {
  const screen = render(<Minimal />);
  await expect.element(screen.getByText(/Screen body goes here/)).toBeVisible();
  expect(screen.container.textContent).not.toContain('8 lenses');
});

test('announces the active lifecycle phase via a role=status live region', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByRole('status')).toHaveTextContent('Running screen');
});

test('moves focus to the screen body on phase CHANGE but not on initial mount', async () => {
  const screen = render(
    <RunLifecycleShell title="Harness" phase="running">
      <div>Body</div>
    </RunLifecycleShell>,
  );
  const body = () => screen.container.querySelector('[tabindex="-1"]');
  // Initial mount must not steal focus onto the body container.
  expect(document.activeElement).not.toBe(body());

  // Auto-transition into RESULTS moves focus to the freshly-swapped screen body.
  screen.rerender(
    <RunLifecycleShell title="Harness" phase="results">
      <div>Body</div>
    </RunLifecycleShell>,
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(body()));
});
