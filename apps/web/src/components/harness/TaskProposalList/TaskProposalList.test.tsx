import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TaskProposalList.stories';

const { WithProposals, Empty } = composeStories(stories);

test('renders each proposal with its kind and convert signals', async () => {
  const screen = render(<WithProposals />);
  await expect
    .element(
      screen.getByRole('heading', {
        name: 'Adopt the folder-per-component agent contract',
      }),
    )
    .toBeInTheDocument();
  // The agent-task proposal surfaces its verify command as a convert signal.
  await expect.element(screen.getByText(/verify: npx eslint \./i)).toBeInTheDocument();
  // A converted proposal shows its lifecycle badge — standardized to "task" (exact,
  // so it doesn't also match the "Agent task" kind label).
  await expect
    .element(screen.getByText('task', { exact: true }))
    .toBeInTheDocument();
});

test('opens a proposal when its card is clicked', async () => {
  const onOpen = vi.fn();
  const screen = render(<WithProposals onOpen={onOpen} />);
  await screen
    .getByRole('heading', { name: 'Adopt the folder-per-component agent contract' })
    .click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0]?.[0]?.id).toBe('hp-1');
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/run a scan to synthesize proposals/i))
    .toBeInTheDocument();
});
