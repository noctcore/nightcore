import type { Meta, StoryObj } from '@storybook/react-vite';

import { StaleChip } from './StaleChip';

const meta = {
  title: 'Issues/StaleChip',
  component: StaleChip,
  args: { title: 'The issue changed on GitHub since it was last validated' },
} satisfies Meta<typeof StaleChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
