import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ConventionGrid.stories';

const { WithFindings, Empty, Streaming } = composeStories(stories);

test('renders a card per convention finding', async () => {
  const screen = render(<WithFindings />);
  await expect
    .element(screen.getByText('Folder-per-component with a colocated sibling set'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText('No enforced cross-feature import boundary'))
    .toBeInTheDocument();
});

test('opens a finding when its card is clicked', async () => {
  const onOpen = vi.fn();
  const screen = render(<WithFindings onOpen={onOpen} />);
  await screen.getByText('Folder-per-component with a colocated sibling set').click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0]?.[0]?.id).toBe('c1');
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/run a scan to surface the conventions/i))
    .toBeInTheDocument();
});

test('marks the grid busy while streaming skeleton cards', async () => {
  const screen = render(<Streaming />);
  expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
});
