import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SeatCanvas.stories';

const { TwoSeats, Waiting, Idle } = composeStories(stories);

test('renders one node per seat, labelled by seat + role, with its latest turn', async () => {
  const screen = render(<TwoSeats />);
  await expect
    .element(screen.getByRole('region', { name: 'Seat proposer-1 (proposer)' }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('region', { name: 'Seat critic-1 (critic)' }))
    .toBeInTheDocument();
  // The node shows the seat's most recent contribution (markdown-rendered).
  await expect
    .element(screen.getByText(/dual-write bug risk during cutover/))
    .toBeInTheDocument();
});

test('shows a "waiting for seats" empty state while a run has no seats yet', async () => {
  const screen = render(<Waiting />);
  await expect.element(screen.getByText('Waiting for seats')).toBeInTheDocument();
});

test('shows a "no council running" empty state when idle', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText('No council running')).toBeInTheDocument();
});
