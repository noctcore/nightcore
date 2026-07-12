import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { DetailCardGrid } from './DetailCardGrid';
import * as stories from './DetailCardGrid.stories';

const { WithCards, Streaming, Empty, ManyCards, WithFullWidthRow } = composeStories(stories);

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

test('virtualizes: a large item count mounts only a bounded window, not all N', async () => {
  // 300 cards in a 360px-tall viewport: only the rows near the viewport (+
  // overscan) mount as `[data-index]` rows — the far end of the list never
  // reaches the DOM until it's scrolled into view.
  const screen = render(<ManyCards />);
  await expect.element(screen.getByText('Finding #1')).toBeInTheDocument();

  const mountedRows = screen.container.querySelectorAll('[data-index]');
  expect(mountedRows.length).toBeGreaterThan(0);
  expect(mountedRows.length).toBeLessThan(300);
  expect(screen.getByText('Finding #300').query()).toBeNull();
});

test('a GridFullRow item gets its own full-width row beside packed cards', async () => {
  const screen = render(<WithFullWidthRow />);
  await expect
    .element(screen.getByText('Section banner — spans every column'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('An example finding')).toBeInTheDocument();
});

test('scrollsWithPage mode virtualizes against the nearest scrollable ancestor', async () => {
  // No `overflow-y-auto` of its own (scrollsWithPage) — the grid must find and
  // virtualize against the wrapping scrollable div instead, exactly like PR
  // Review's ancestor `<main>` panel, and still bound the mounted DOM.
  const cards = Array.from({ length: 200 }, (_, i) => (
    <div key={i}>ancestor-card-{i}</div>
  ));
  const screen = render(
    <div style={{ height: 300, overflowY: 'auto' }}>
      <div style={{ height: 40 }}>Header content above the grid</div>
      <DetailCardGrid isEmpty={false} emptyMessage="none" skeletonCount={0} scrollsWithPage>
        {cards}
      </DetailCardGrid>
    </div>,
  );

  await expect.element(screen.getByText('ancestor-card-0')).toBeInTheDocument();
  const mountedRows = screen.container.querySelectorAll('[data-index]');
  expect(mountedRows.length).toBeGreaterThan(0);
  expect(mountedRows.length).toBeLessThan(200);
});
