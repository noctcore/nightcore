import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';

import { useElapsedMs } from './RunProgress.hooks';
import * as stories from './RunProgress.stories';

const { Running, CustomUnitLabel, Synthesizing, WithError, Completed } = composeStories(stories);

test('renders the overall bar with the finished/total lens count', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText(/2 \/ 6 lenses · 33%/)).toBeVisible();
  await expect
    .element(screen.getByRole('progressbar', { name: /overall progress/i }))
    .toHaveAttribute('aria-valuenow', '33');
});

test('shows finding counts on done rows and the scanning label on the running row', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('8 findings')).toBeVisible();
  await expect.element(screen.getByText('scanning…')).toBeVisible();
});

test('parameterizes the unit noun via unitLabel (defaults to lenses)', async () => {
  const screen = render(<CustomUnitLabel />);
  await expect.element(screen.getByText(/2 \/ 6 categories · 33%/)).toBeVisible();
});

test('announces discrete progress via a role=status live region', async () => {
  const screen = render(<Running />);
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent('2 / 6 lenses · 33%');
});

test('renders pending rows as non-button queued rows', async () => {
  const screen = render(<Running />);
  // Done categories are buttons; queued ones are not.
  await expect.element(screen.getByRole('button', { name: /Architecture/ })).toBeInTheDocument();
  expect(screen.container.textContent).toContain('queued');
});

test('fires onOpenCategory when a done row is clicked', async () => {
  const onOpenCategory = vi.fn();
  const screen = render(<Running onOpenCategory={onOpenCategory} />);
  await screen.getByRole('button', { name: /Imports & Boundaries/ }).click();
  expect(onOpenCategory).toHaveBeenCalledWith('imports');
});

test('shows the synthesis row only while synthesizing', async () => {
  const running = render(<Running />);
  expect(running.container.textContent).not.toContain('Synthesizing harness');
  const synth = render(<Synthesizing />);
  await expect.element(synth.getByText(/Synthesizing harness/)).toBeVisible();
});

test('renders an errored lens row that is still clickable', async () => {
  const onOpenCategory = vi.fn();
  const screen = render(<WithError onOpenCategory={onOpenCategory} />);
  await expect.element(screen.getByText('failed')).toBeVisible();
  await screen.getByRole('button', { name: /Imports & Boundaries/ }).click();
  expect(onOpenCategory).toHaveBeenCalledWith('imports');
});

test('shows a full bar and "complete" status on a terminal run', async () => {
  const screen = render(<Completed />);
  await expect.element(screen.getByText(/6 \/ 6 lenses · 100%/)).toBeVisible();
  await expect.element(screen.getByText('complete')).toBeVisible();
});

test('useElapsedMs returns the backend duration when not running', async () => {
  let result = 0;
  function Probe() {
    result = useElapsedMs(false, 45000);
    return null;
  }
  render(<Probe />);
  await vi.waitFor(() => expect(result).toBe(45000));
});
