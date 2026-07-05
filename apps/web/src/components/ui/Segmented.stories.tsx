import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Segmented } from './Segmented';

const meta = {
  title: 'UI/Segmented',
  component: Segmented,
  args: {
    options: [
      ['opus', 'Opus'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku'],
    ],
    value: 'sonnet',
    onChange: fn(),
  },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Segmented>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The active pill slides to the selected segment (transform-only). */
export const Default: Story = {};

/** Play test: clicking another segment fires onChange with its value. */
export const FiresOnChange: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Haiku' }));
    await expect(args.onChange).toHaveBeenCalledWith('haiku');
  },
};

/** Visible-but-inert (a not-yet-built affordance). */
export const Disabled: Story = { args: { disabled: true } };
