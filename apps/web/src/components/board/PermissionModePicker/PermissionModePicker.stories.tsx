import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PermissionModePicker } from './PermissionModePicker';

const meta = {
  title: 'Board/PermissionModePicker',
  component: PermissionModePicker,
  args: {
    value: null,
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionModePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inherit: Story = {};

export const Bypass: Story = { args: { value: 'bypass' } };

export const Plan: Story = { args: { value: 'plan' } };

export const Disabled: Story = { args: { value: 'ask', disabled: true } };

/** Play test: picking Plan fires onChange with the mode. */
export const PicksPlan: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /^plan$/i }));
    await expect(args.onChange).toHaveBeenCalledWith('plan');
  },
};

/** Play test: the Inherit option fires onChange with null. */
export const PicksInherit: Story = {
  args: { value: 'bypass' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /inherit/i }));
    await expect(args.onChange).toHaveBeenCalledWith(null);
  },
};
