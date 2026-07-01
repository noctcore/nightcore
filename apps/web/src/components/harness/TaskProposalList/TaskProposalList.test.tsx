import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
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
  // A converted proposal shows its lifecycle badge (exact, so it doesn't also match
  // a title containing the word "converted").
  await expect
    .element(screen.getByText('converted', { exact: true }))
    .toBeInTheDocument();
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/run a scan to synthesize proposals/i))
    .toBeInTheDocument();
});
