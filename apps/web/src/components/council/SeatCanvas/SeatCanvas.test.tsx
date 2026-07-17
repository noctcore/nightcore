import { composeStories } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type {
  CouncilRoutingControls,
  CouncilRoutingEdge,
  SeatStream,
} from '../council.types';
import { SeatCanvas } from './SeatCanvas';
import * as stories from './SeatCanvas.stories';

const { TwoSeats, ReadOnlyRouting, Waiting, Idle } = composeStories(stories);

const SEATS: SeatStream[] = [
  {
    seatId: 'proposer-1',
    role: 'proposer',
    latestStage: 'debate',
    latestContent: 'Plan A: feature-flag migration.',
    messages: [{ seq: 1, stage: 'debate', content: 'Plan A.' }],
  },
  {
    seatId: 'critic-1',
    role: 'critic',
    latestStage: 'debate',
    latestContent: 'A dual-write bug risk during cutover.',
    messages: [{ seq: 2, stage: 'debate', content: 'Risk.' }],
  },
];

/** All directed peer pairs (`a → b`, a ≠ b) — the materialized OPEN graph. */
function allPairs(): CouncilRoutingEdge[] {
  return SEATS.flatMap((a) =>
    SEATS.filter((b) => b.seatId !== a.seatId).map((b) => ({
      from: a.seatId,
      to: b.seatId,
    })),
  );
}

/** A stateful harness that implements the routing controller over local edge state, so a
 *  toggle actually rewires the graph the canvas renders (the real controller lives in
 *  CouncilView.hooks; here it is inlined to unit-test the canvas's edit affordance). */
function EditableCanvas() {
  const [edges, setEdges] = useState<CouncilRoutingEdge[] | null>(null);
  const routing: CouncilRoutingControls = {
    editable: true,
    open: edges === null,
    informs: (from, to) =>
      edges === null
        ? from !== to
        : edges.some((e) => e.from === from && e.to === to),
    toggle: (from, to) =>
      setEdges((prev) => {
        const current = prev ?? allPairs();
        const exists = current.some((e) => e.from === from && e.to === to);
        return exists
          ? current.filter((e) => !(e.from === from && e.to === to))
          : [...current, { from, to }];
      }),
  };
  return <SeatCanvas seats={SEATS} phase="running" routing={routing} />;
}

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

test('each node exposes an editable "Informed by" toggle per peer, reflecting the graph', async () => {
  const screen = render(<EditableCanvas />);
  // Open routing: proposer-1 informs critic-1 by default — the chip reads pressed.
  const chip = screen.getByRole('button', {
    name: 'proposer-1 informs critic-1',
  });
  await expect.element(chip).toHaveAttribute('aria-pressed', 'true');
  await expect.element(chip).toBeEnabled();

  // Toggling it CUTS the edge — the routing graph the canvas renders updates in place.
  await chip.click();
  await expect
    .element(
      screen.getByRole('button', { name: 'proposer-1 informs critic-1' }),
    )
    .toHaveAttribute('aria-pressed', 'false');
});

test('routing chips are read-only (disabled) when a run is not live', async () => {
  const screen = render(<ReadOnlyRouting />);
  await expect
    .element(screen.getByRole('button', { name: 'proposer-1 informs critic-1' }))
    .toBeDisabled();
});

test('shows a "waiting for seats" empty state while a run has no seats yet', async () => {
  const screen = render(<Waiting />);
  await expect.element(screen.getByText('Waiting for seats')).toBeInTheDocument();
});

test('shows a "no council running" empty state when idle', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText('No council running')).toBeInTheDocument();
});
