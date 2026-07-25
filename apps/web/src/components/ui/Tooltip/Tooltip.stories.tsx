import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { MotionProvider } from '../motion';
import { Tooltip } from './Tooltip';

const meta = {
  title: 'UI/Tooltip',
  component: Tooltip,
  decorators: [
    (Story) => (
      <MotionProvider>
        <div className="p-10">
          <Story />
        </div>
      </MotionProvider>
    ),
  ],
  parameters: { layout: 'centered' },
  args: {
    label: 'Copy to clipboard',
    children: (
      <button
        type="button"
        aria-label="Copy"
        className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground"
      >
        Hover me
      </button>
    ),
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Below: Story = { args: { side: 'bottom' } };

/** Play test: hovering reveals the tip. */
export const RevealsOnHover: Story = {
  args: { delayMs: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('button', { name: 'Copy' }));
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('Copy to clipboard');
  },
};
