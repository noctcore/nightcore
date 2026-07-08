import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { IconPicker } from './IconPicker';

const meta = {
  title: 'UI/IconPicker',
  component: IconPicker,
  args: { selectedIcon: 'FolderCode', onSelectIcon: fn() },
} satisfies Meta<typeof IconPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
