import type { Meta, StoryObj } from '@storybook/react-vite';

import type { CouncilRoutingControls, SeatStream } from '../council.types';
import { SeatCanvas } from './SeatCanvas';

const SEATS: SeatStream[] = [
  {
    seatId: 'proposer-1',
    role: 'proposer',
    latestStage: 'debate',
    latestContent: '**Plan A:** migrate the store behind a feature flag, then cut over.',
    messages: [
      { seq: 1, stage: 'propose', content: 'Plan A: feature-flag migration.' },
      { seq: 4, stage: 'debate', content: '**Plan A:** migrate the store behind a feature flag, then cut over.' },
    ],
  },
  {
    seatId: 'critic-1',
    role: 'critic',
    latestStage: 'debate',
    latestContent: 'The flag doubles the write path — a dual-write bug risk during cutover.',
    messages: [
      { seq: 5, stage: 'debate', content: 'The flag doubles the write path — a dual-write bug risk during cutover.' },
    ],
  },
];

/** An OPEN, editable routing controller — every seat informs every other (the P1 default),
 *  edits enabled. The toggle is a no-op in the static story (behavior is unit-tested). */
const OPEN_ROUTING: CouncilRoutingControls = {
  editable: true,
  open: true,
  informs: (from, to) => from !== to,
  toggle: () => {},
};

const meta = {
  title: 'Council/SeatCanvas',
  component: SeatCanvas,
  args: { seats: SEATS, phase: 'running', routing: OPEN_ROUTING },
} satisfies Meta<typeof SeatCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoSeats: Story = {};

/** A settled run: routing is shown read-only (editing is live-only). */
export const ReadOnlyRouting: Story = {
  args: { routing: { ...OPEN_ROUTING, editable: false } },
};

export const Waiting: Story = { args: { seats: [], phase: 'running' } };

export const Idle: Story = { args: { seats: [], phase: 'idle' } };
