import type { Meta, StoryObj } from '@storybook/react-vite';

import { Splash } from './Splash';

const meta = {
  title: 'App/Splash',
  component: Splash,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Splash>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomBootLine: Story = {
  args: { bootLine: 'loading projects…', version: 'v0.2.0' },
};
