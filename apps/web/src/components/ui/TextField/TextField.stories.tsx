import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { FieldLabel, TextField } from './TextField';

const meta = {
  title: 'UI/TextField',
  component: TextField,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex w-64 flex-col gap-1.5">
      <FieldLabel htmlFor="story-title">Title</FieldLabel>
      <TextField id="story-title" placeholder="feat: what this ships" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Title')).toBeInTheDocument();
    await expect(canvas.getByPlaceholderText('feat: what this ships')).toBeInTheDocument();
  },
};
