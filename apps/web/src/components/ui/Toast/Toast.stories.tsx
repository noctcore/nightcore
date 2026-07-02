import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from '../Button';
import { ToastProvider } from './Toast';
import { useToast } from './Toast.hooks';

/** Demo surface: buttons that push a toast of each tone through `useToast()`. */
function ToastDemo() {
  const { push, error } = useToast();
  return (
    <div className="flex gap-2 p-5">
      <Button onClick={() => error('Task failed', new Error('exit code 1'))}>Fail</Button>
      <Button onClick={() => push({ tone: 'success', title: 'Task merged' })}>Succeed</Button>
      <Button onClick={() => push({ tone: 'info', title: 'Worktree pruned' })}>Inform</Button>
    </div>
  );
}

const meta = {
  title: 'UI/Toast',
  component: ToastProvider,
  args: { children: <ToastDemo /> },
} satisfies Meta<typeof ToastProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The provider plus demo triggers; toasts stack bottom-right above overlays. */
export const Default: Story = {};

/** Play test: an error push surfaces a `role="alert"` toast with the coerced detail. */
export const ErrorToast: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fail' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('Task failed');
    await expect(alert).toHaveTextContent('exit code 1');
  },
};

/** Play test: non-error tones announce politely via `role="status"`. */
export const SuccessToast: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Succeed' }));
    const status = await canvas.findByRole('status');
    await expect(status).toHaveTextContent('Task merged');
  },
};
