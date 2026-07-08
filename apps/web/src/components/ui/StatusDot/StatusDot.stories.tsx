import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusDot } from './StatusDot';

const meta = {
  title: 'UI/StatusDot',
  component: StatusDot,
  parameters: { layout: 'centered' },
  args: { colorClass: 'bg-primary' },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Pulsing: Story = { args: { pulse: true } };

export const WithGlow: Story = { args: { glow: true, colorClass: 'bg-emerald-500' } };
