import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { DetailCardGrid } from './DetailCardGrid';
import * as stories from './DetailCardGrid.stories';

const { WithCards, Streaming, Empty } = composeStories(stories);

test('renders its card children', async () => {
  const screen = render(<WithCards />);
  await expect.element(screen.getByText('An example finding')).toBeInTheDocument();
});

test('marks the grid busy while streaming skeleton cards', async () => {
  const screen = render(<Streaming />);
  expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Nothing to show yet.')).toBeInTheDocument();
});

test('caps the mounted cards and reveals more on demand', async () => {
  // 70 cards > the 60-card page: only the first 60 mount, the last 10 stay
  // behind a "Show more" affordance, and clicking it reveals them — in order.
  const cards = Array.from({ length: 70 }, (_, i) => <div key={i}>card-{i}</div>);
  const screen = render(
    <DetailCardGrid isEmpty={false} emptyMessage="none" skeletonCount={0}>
      {cards}
    </DetailCardGrid>,
  );

  await expect.element(screen.getByText('card-59')).toBeInTheDocument();
  expect(screen.getByText('card-60').query()).toBeNull();

  await screen.getByRole('button', { name: /show 10 more/i }).click();

  await expect.element(screen.getByText('card-69')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /show/i }).query()).toBeNull();
});
