import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ProjectIconEditor } from './ProjectIconEditor';

const meta = {
  title: 'UI/ProjectIconEditor',
  component: ProjectIconEditor,
  args: {
    icon: 'FolderCode',
    imageUrl: null,
    hasCustomImage: false,
    onIconChange: fn(),
    onImageChange: fn(),
    onRemoveImage: fn(),
  },
} satisfies Meta<typeof ProjectIconEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
