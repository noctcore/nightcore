import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from '../Button';
import { Modal } from './Modal';

const meta = {
  title: 'UI/Modal',
  component: Modal,
  args: {
    open: true,
    label: 'Example dialog',
    onClose: fn(),
  },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A minimal dialog with two focusable controls — exercises the focus trap. */
export const Default: Story = {
  args: {
    children: (
      <div className="flex flex-col gap-3 p-5">
        <h2 className="text-base font-semibold text-foreground">Example dialog</h2>
        <input aria-label="First field" placeholder="First field" className="rounded border px-2 py-1" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost">Cancel</Button>
          <Button data-confirm>Confirm</Button>
        </div>
      </div>
    ),
  },
};

/** Play test: Escape routes to onClose. */
export const EscapeCloses: Story = {
  args: { ...Default.args },
  play: async ({ args }) => {
    await userEvent.keyboard('{Escape}');
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Play test: focus lands on the element matched by `initialFocus`. */
export const InitialFocus: Story = {
  args: { ...Default.args, initialFocus: '[data-confirm]' },
  play: async () => {
    const confirm = within(document.body).getByRole('button', { name: 'Confirm' });
    await expect(confirm).toHaveFocus();
  },
};

/** Presence: with `open={false}`, Modal owns its presence and renders no dialog —
 *  the same prop drives the enter/exit choreography in the app. */
export const Closed: Story = {
  args: { ...Default.args, open: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[role="dialog"]')).toBeNull();
  },
};
