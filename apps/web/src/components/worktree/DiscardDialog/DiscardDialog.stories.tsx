import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DiscardDialog } from './DiscardDialog';

const meta = {
  title: 'Worktree/DiscardDialog',
  component: DiscardDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    branch: 'feature/login',
    onConfirm: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof DiscardDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** No branch name — the copy falls back to "this task". */
export const NoBranch: Story = { args: { branch: undefined } };

/** Uncommitted work present — the amber warning line appears. */
export const WithUncommittedChanges: Story = { args: { changedFiles: 3 } };

/** Discard in flight — the confirm button shows a spinner and is disabled. */
export const Discarding: Story = { args: { discarding: true } };

/** A failed discard — the error is shown and the button flips to "Retry". */
export const WithError: Story = {
  args: { error: 'fatal: worktree is locked' },
};

/** Play test: clicking Discard invokes onConfirm and does NOT close. */
export const ConfirmsOnClick: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Discard' }));
    await expect(args.onConfirm).toHaveBeenCalled();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

/** Play test: clicking Cancel invokes onClose. */
export const CancelsOnClick: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Play test: an error flips the confirm button to "Retry", which still confirms. */
export const RetriesOnError: Story = {
  args: { error: 'fatal: worktree is locked' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('fatal: worktree is locked')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onConfirm).toHaveBeenCalled();
  },
};

/** Play test: uncommitted changes surface the amber data-loss warning. */
export const WarnsOnUncommitted: Story = {
  args: { changedFiles: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/2 uncommitted file\(s\) will be lost\./i)).toBeInTheDocument();
  },
};
