import type { Meta, StoryObj } from '@storybook/react-vite';

import { UpdateChecker } from './UpdateChecker';

const meta = {
  title: 'Settings/UpdateChecker',
  component: UpdateChecker,
  args: {
    isAppIdle: true,
    checkOnStartup: false,
  },
} satisfies Meta<typeof UpdateChecker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Browser preview — updater seam is unavailable outside Tauri. */
export const BrowserPreview: Story = {};

export const Deferred: Story = {
  args: { isAppIdle: false },
};