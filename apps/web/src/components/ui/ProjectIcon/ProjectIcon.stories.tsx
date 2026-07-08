import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProjectIcon } from './ProjectIcon';

const meta = {
  title: 'UI/ProjectIcon',
  component: ProjectIcon,
  args: { size: 24, icon: 'FolderCode' },
} satisfies Meta<typeof ProjectIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preset: Story = {};

export const Fallback: Story = {
  args: { icon: null },
};

export const CustomImage: Story = {
  args: {
    icon: null,
    imageUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
};
