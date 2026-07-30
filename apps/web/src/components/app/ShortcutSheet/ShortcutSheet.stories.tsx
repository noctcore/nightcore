import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { APP_SHELL_NAV } from '../AppShell/nav.constants';
import { ShortcutSheet } from './ShortcutSheet';

const meta = {
  title: 'App/ShortcutSheet',
  component: ShortcutSheet,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    // The real nav list, so the story shows exactly what a user sees.
    nav: APP_SHELL_NAV,
    onClose: fn(),
  },
} satisfies Meta<typeof ShortcutSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Closed — the Modal owns its presence, so nothing is rendered. */
export const Closed: Story = { args: { open: false } };
