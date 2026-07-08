import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { MotionProvider } from '../motion';
import { Button } from './Button';

const meta = {
  title: 'UI/Button',
  component: Button,
  decorators: [(Story) => <MotionProvider><Story /></MotionProvider>],
  parameters: { layout: 'centered' },
  args: { children: 'Save', onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = { args: { variant: 'secondary', children: 'Cancel' } };

export const Ghost: Story = { args: { variant: 'ghost', children: 'Dismiss' } };

export const Danger: Story = { args: { variant: 'danger', children: 'Delete' } };

export const Disabled: Story = { args: { disabled: true } };

/** Play test: clicking the button invokes onClick. */
export const FiresOnClick: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(args.onClick).toHaveBeenCalled();
  },
};
