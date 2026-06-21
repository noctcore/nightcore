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

/** Play test: the reserved Review kind is disabled and never fires onChange. */
export const ReviewIsComingSoon: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const review = canvas.getByRole('radio', { name: /review/i });
    await expect(review).toBeDisabled();
    await userEvent.click(review);
    await expect(args.onChange).not.toHaveBeenCalled();
  },
};
