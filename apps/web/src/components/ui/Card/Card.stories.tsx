import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Card } from './Card';

const meta = {
  title: 'UI/Card',
  component: Card,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: <p className="p-4 text-sm">Card body</p> },
};

export const Selected: Story = {
  args: {
    selected: true,
    children: <p className="p-4 text-sm">Selected card</p>,
  },
};

export const RendersChildren: Story = {
  args: { children: <p className="p-4 text-sm">Hello card</p> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Hello card')).toBeInTheDocument();
  },
};
