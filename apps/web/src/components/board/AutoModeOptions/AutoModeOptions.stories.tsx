import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';

import { BoltIcon, ToolbarOption } from '@/components/ui';

import { AutoModeOptions } from './AutoModeOptions';

const meta = {
  title: 'Board/AutoModeOptions',
  component: AutoModeOptions,
  args: {
    autoCommitOnVerified: false,
    onAutoCommitChange: fn(),
    autoPauseUsageThreshold: 90,
    onThresholdChange: fn(),
    usageMeterEnabled: true,
  },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 24, width: 420 }}>
        <ToolbarOption
          label="Auto Mode"
          on={false}
          onToggle={() => {}}
          icon={<BoltIcon size={14} className="text-muted-foreground" />}
          settingsLabel="Auto Mode options"
          settings={<Story />}
        />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoModeOptions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed — settings content inside a ToolbarOption, as on the board header. */
export const Collapsed: Story = {};

/** Auto-commit already enabled (open the gear to see the switch on). */
export const Enabled: Story = { args: { autoCommitOnVerified: true } };

/** The usage-throttle slider at its 90% default (meter enabled). */
export const ThresholdDefault: Story = { args: { autoPauseUsageThreshold: 90 } };

/** The usage-throttle slider dialed down to its 50% floor. */
export const ThresholdFloor: Story = { args: { autoPauseUsageThreshold: 50 } };

/** Meter off: the slider renders disabled with the "Enable the usage meter" hint. */
export const MeterDisabled: Story = { args: { usageMeterEnabled: false } };

/** Play test: opening the gear and moving the slider reports the next threshold. */
export const ChangesThreshold: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /auto mode options/i }));
    const slider = canvas.getByRole('slider', { name: /pause auto mode at usage/i });
    fireEvent.change(slider, { target: { value: '75' } });
    await expect(args.onThresholdChange).toHaveBeenCalledWith(75);
  },
};
