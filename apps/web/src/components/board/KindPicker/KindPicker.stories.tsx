import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { KindPicker } from './KindPicker';

const meta = {
  title: 'Board/KindPicker',
  component: KindPicker,
  args: {
    value: 'build',
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KindPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Build: Story = {};

export const Research: Story = { args: { value: 'research' } };

export const Tdd: Story = { args: { value: 'tdd' } };

export const Decompose: Story = { args: { value: 'decompose' } };

export const Compact: Story = { args: { compact: true } };

export const Disabled: Story = { args: { disabled: true } };

/** Play test: picking Research (an enabled kind) fires onChange. */
export const PicksResearch: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /research/i }));
    await expect(args.onChange).toHaveBeenCalledWith('research');
  },
};

/** Play test: picking TDD (newly enabled) threads the `tdd` kind through. */
export const PicksTdd: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /tdd/i }));
    await expect(args.onChange).toHaveBeenCalledWith('tdd');
  },
};

/** Play test: Decompose is now a selectable kind (no longer "coming soon"). */
export const PicksDecompose: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const decompose = canvas.getByRole('radio', { name: /decompose/i });
    await expect(decompose).not.toBeDisabled();
    await userEvent.click(decompose);
    await expect(args.onChange).toHaveBeenCalledWith('decompose');
  },
};
