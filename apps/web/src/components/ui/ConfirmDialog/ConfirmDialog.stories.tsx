import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ConfirmDialog } from './ConfirmDialog';

const meta = {
  title: 'UI/ConfirmDialog',
  component: ConfirmDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    title: 'Remove project?',
    message:
      'This removes the project from Nightcore. Files on disk are left untouched.',
    confirmLabel: 'Remove',
    destructive: true,
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Destructive: Story = {};

export const Neutral: Story = {
  args: {
    title: 'Discard changes?',
    message: 'Your unsaved edits will be lost.',
    confirmLabel: 'Discard',
    destructive: false,
  },
};

/** Play test: clicking the confirm button invokes onConfirm. */
export const ConfirmsOnClick: Story = {
  play: async ({ args }) => {
    const body = within(document.body);
    await userEvent.click(body.getByRole('button', { name: 'Remove' }));
    await expect(args.onConfirm).toHaveBeenCalled();
  },
};

/** Play test: clicking Cancel invokes onCancel. */
export const CancelsOnClick: Story = {
  play: async ({ args }) => {
    const body = within(document.body);
    await userEvent.click(body.getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalled();
  },
};
