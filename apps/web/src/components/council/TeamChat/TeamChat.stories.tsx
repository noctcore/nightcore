import type { Meta, StoryObj } from '@storybook/react-vite';

import type { TeamChatEntry } from '../council.types';
import { TeamChat } from './TeamChat';

const CHAT: TeamChatEntry[] = [
  { seq: 0, seatId: 'conductor', role: 'conductor', kind: 'note', stage: 'frame', content: 'Framing the debate over the migration strategy.', at: 1 },
  { seq: 1, seatId: 'conductor', role: 'conductor', kind: 'broadcast', stage: 'propose', content: 'Propose a migration strategy.', at: 2 },
  { seq: 2, seatId: 'proposer-1', role: 'proposer', kind: 'message', stage: 'propose', content: '**Plan A:** feature-flag the store, then cut over.', at: 3 },
  { seq: 3, seatId: 'proposer-1', role: 'critic', kind: 'delivery', stage: 'debate', content: 'Seat proposer-1 said: "feature-flag the store, then cut over."', at: 4, broadcastId: 'bc-1', injectionFlags: [] },
];

const meta = {
  title: 'Council/TeamChat',
  component: TeamChat,
  args: { chat: CHAT },
} satisfies Meta<typeof TeamChat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = { args: { chat: [] } };
