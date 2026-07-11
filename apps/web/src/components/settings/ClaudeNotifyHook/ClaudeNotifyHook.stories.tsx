import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';

import { ToastProvider } from '@/components/ui';

import { ClaudeNotifyHook } from './ClaudeNotifyHook';

const meta = {
  title: 'Settings/ClaudeNotifyHook',
  component: ClaudeNotifyHook,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof ClaudeNotifyHook>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default "Copy hook" affordance. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole('button', { name: /Copy the Claude Code notify hook/ }),
    ).toBeInTheDocument();
  },
};

/** Clicking copies the snippet and flips the button to its "Copied" confirm state.
 *  The headless runner has no real Clipboard API, so the play stubs `writeText`. */
export const Copies: Story = {
  play: async ({ canvas }) => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
    await userEvent.click(canvas.getByRole('button'));
    await expect(canvas.getByText('Copied')).toBeInTheDocument();
  },
};
