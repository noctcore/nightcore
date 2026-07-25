import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { CouncilStartPanel } from './CouncilStartPanel';

const meta = {
  title: 'Council/CouncilStartPanel',
  component: CouncilStartPanel,
  args: { onStart: fn(async () => {}) },
} satisfies Meta<typeof CouncilStartPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoProject: Story = { args: { disabled: true } };
