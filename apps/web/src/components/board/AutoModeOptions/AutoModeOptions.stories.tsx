import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AutoModeOptions } from './AutoModeOptions';

const meta = {
  title: 'Board/AutoModeOptions',
  component: AutoModeOptions,
  args: {
    autoCommitOnVerified: false,
    onAutoCommitChange: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 24, width: 420 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoModeOptions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed — just the gear trigger, as it sits in the board header. */
export const Collapsed: Story = {};

/** Auto-commit already enabled (the panel is still collapsed until clicked). */
export const Enabled: Story = { args: { autoCommitOnVerified: true } };
