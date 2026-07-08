import type { Meta, StoryObj } from '@storybook/react-vite';

import { Skeleton } from './Skeleton';

const meta = {
  title: 'UI/Skeleton',
  component: Skeleton,
  parameters: { layout: 'centered' },
  args: { className: 'h-3 w-24' },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Line: Story = {};

export const Block: Story = { args: { className: 'h-16 w-48 rounded-lg' } };
