import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { NumberField } from './NumberField';

const meta = {
  title: 'UI/NumberField',
  component: NumberField,
  parameters: { layout: 'centered' },
  args: {
    value: null,
    placeholder: '8192',
    ariaLabel: 'Token limit',
    min: 0,
    onCommit: fn(),
  },
} satisfies Meta<typeof NumberField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyInherit: Story = {};

export const WithValue: Story = { args: { value: 4096 } };

export const WithPrefix: Story = { args: { value: 100, prefix: '$' } };

/** Play test: Enter commits the typed value. */
export const CommitsOnEnter: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('spinbutton', { name: 'Token limit' });
    await userEvent.clear(input);
    await userEvent.type(input, '2048');
    await userEvent.keyboard('{Enter}');
    await expect(args.onCommit).toHaveBeenCalledWith(2048);
  },
};
