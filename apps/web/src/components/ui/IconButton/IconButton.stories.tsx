import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { DotsIcon } from '../icons';
import { MotionProvider } from '../motion';
import { IconButton } from './IconButton';

const meta = {
  title: 'UI/IconButton',
  component: IconButton,
  decorators: [(Story) => <MotionProvider><Story /></MotionProvider>],
  parameters: { layout: 'centered' },
  args: {
    label: 'More options',
    children: <DotsIcon size={16} />,
    onClick: fn(),
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Play test: clicking invokes onClick. */
export const FiresOnClick: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'More options' }));
    await expect(args.onClick).toHaveBeenCalled();
  },
};
