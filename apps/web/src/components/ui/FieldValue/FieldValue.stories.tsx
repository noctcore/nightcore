import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { FieldValue } from './FieldValue';

const meta = {
  title: 'UI/FieldValue',
  component: FieldValue,
  parameters: { layout: 'centered' },
  args: { children: 'main' },
} satisfies Meta<typeof FieldValue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RendersValue: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('main')).toBeInTheDocument();
  },
};
