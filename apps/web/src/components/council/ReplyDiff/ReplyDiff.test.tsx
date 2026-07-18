import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ReplyDiff.stories';

const { TwoRounds, Aligned, Empty } = composeStories(stories);

test('renders every seat reply of a round side-by-side, labelled by seat + role', async () => {
  const screen = render(<TwoRounds />);
  // Both rounds are present, each as a labelled region.
  await expect
    .element(screen.getByRole('region', { name: 'Propose replies' }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('region', { name: 'Debate · round 1 replies' }))
    .toBeInTheDocument();
  // The N replies of the Propose round are rendered as distinct columns — disagreement
  // is NOT collapsed. (The seat ids recur across rounds, so scope to the Propose region.)
  const propose = screen.getByRole('region', { name: 'Propose replies' });
  await expect
    .element(propose.getByRole('article', { name: 'Seat proposer-opus reply' }))
    .toBeInTheDocument();
  await expect
    .element(propose.getByRole('article', { name: 'Seat critic-opus reply' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText(/Big-bang/)).toBeInTheDocument();
});

test('flags the final round as the positions the human judges', async () => {
  const screen = render(<TwoRounds />);
  await expect.element(screen.getByText('Final positions')).toBeInTheDocument();
});

test('surfaces divergence — a round where replies differ is marked with its position count', async () => {
  const screen = render(<TwoRounds />);
  const propose = screen.getByRole('region', { name: 'Propose replies' });
  await expect.element(propose.getByText('3 distinct positions')).toBeInTheDocument();
});

test('marks an aligned round (identical replies) as no disagreement', async () => {
  const screen = render(<Aligned />);
  await expect.element(screen.getByText('Aligned')).toBeInTheDocument();
});

test('shows an empty state when no broadcast has resolved yet', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No replies to compare yet')).toBeInTheDocument();
});
