import type { Meta, StoryObj } from '@storybook/react-vite';

import { HumanInputBar } from './HumanInputBar';

const meta = {
  title: 'Council/HumanInputBar',
  component: HumanInputBar,
  parameters: { layout: 'fullscreen' },
  args: {
    seatIds: ['proposer-opus', 'proposer-sonnet', 'critic-opus'],
    live: true,
    // The story dispatch resolves immediately; the real one routes through the Conductor,
    // which quotes + injection-scans the message before any seat sees it.
    onSend: async () => {},
  },
} satisfies Meta<typeof HumanInputBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {};

/** No run is live — the affordance stays visible but inert (the #352 disabled state). */
export const NoLiveCouncil: Story = { args: { live: false } };

/** Live, but no seat has spoken yet — a DM has nothing to address. */
export const NoSeatsYet: Story = { args: { seatIds: [] } };

/** A dispatch that fails surfaces inline so the human can retry. */
export const DispatchFails: Story = {
  args: {
    onSend: () => Promise.reject(new Error('The sidecar is not running.')),
  },
};
