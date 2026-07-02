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
