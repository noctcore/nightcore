import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './FindingGrid.stories';

const { WithFindings, Empty } = composeStories(stories);

test('renders a card per finding', async () => {
  const screen = render(<WithFindings />);
  await expect.element(screen.getByText('Unawaited promise drops errors')).toBeInTheDocument();
  await expect.element(screen.getByText('Secret in log')).toBeInTheDocument();
});

test('opens a finding when its card is clicked', async () => {
  const onOpen = vi.fn();
  const screen = render(<WithFindings onOpen={onOpen} />);
  await screen.getByText('Unawaited promise drops errors').click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0]?.[0]?.id).toBe('f1');
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/run an analysis to surface findings/i))
    .toBeInTheDocument();
});

test('the stabilized onOpen still invokes the LATEST handler after a re-render', async () => {
  // The memo-enabling stabilizer keeps a single onOpen identity across renders;
  // it must forward to the most recent handler, never a stale closure.
  const first = vi.fn();
  const second = vi.fn();
  const screen = render(<WithFindings onOpen={first} />);
  screen.rerender(<WithFindings onOpen={second} />);
  await screen.getByText('Unawaited promise drops errors').click();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  expect(second.mock.calls[0]?.[0]?.id).toBe('f1');
});
