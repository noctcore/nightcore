import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { ConfirmHint } from './ConfirmHint';

const meta = {
  title: 'UI/ConfirmHint',
  component: ConfirmHint,
  parameters: { layout: 'centered' },
  args: { children: 'to confirm' },
} satisfies Meta<typeof ConfirmHint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Create: Story = { args: { children: 'to create' } };

/** Play test: the hint renders the ⌘/Ctrl + ↵ pairing plus its label. */
export const RendersPairing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('↵')).toBeInTheDocument();
    await expect(canvas.getByText(/^(⌘|Ctrl)$/)).toBeInTheDocument();
    await expect(canvas.getByText(/to confirm/)).toBeInTheDocument();
  },
};
