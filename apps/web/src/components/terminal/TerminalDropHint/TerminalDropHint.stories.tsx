import type { Meta, StoryObj } from '@storybook/react-vite';

import { TerminalDropHint } from './TerminalDropHint';

/** The overlay is `absolute inset-0`, so every story frames it in a `relative` pane-sized
 *  box mimicking a terminal surface. */
const meta = {
  title: 'Terminal/TerminalDropHint',
  component: TerminalDropHint,
  decorators: [
    (Story) => (
      <div className="relative h-48 w-96 overflow-hidden rounded-lg border border-border bg-[#0a0a0f]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalDropHint>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The drop-hint shown on the pane under a dragged file — dropping types the file's
 *  shell-escaped absolute path at the prompt. */
export const Default: Story = {};
