import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { BoltIcon } from '../icons';
import { Toggle } from '../Toggle';
import { ToolbarOption } from './ToolbarOption';

const meta = {
  title: 'UI/ToolbarOption',
  component: ToolbarOption,
  args: {
    label: 'Auto Mode',
    on: false,
    onToggle: fn(),
    icon: <BoltIcon size={14} className="text-muted-foreground" />,
  },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 24, width: 420 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolbarOption>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Off — the default toolbar feature pill. */
export const Off: Story = {};

/** On — active styling with a primary-tinted border and switch track. */
export const On: Story = {
  args: {
    on: true,
    icon: <BoltIcon size={14} className="text-primary" />,
    title: 'Stop Auto Mode',
  },
};

/** With badge — optional trailing count beside the label. */
export const WithBadge: Story = {
  args: {
    badge: (
      <span className="font-mono text-3xs font-semibold text-muted-foreground">5</span>
    ),
  },
};

/** With settings — integrated gear opens a popover below the pill. */
export const WithSettings: Story = {
  args: {
    settingsLabel: 'Auto Mode options',
    settings: (
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs-plus font-semibold text-foreground">Sample option</span>
        <Toggle on={false} onChange={() => {}} label="Sample option" />
      </div>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Auto Mode options' }));
    await expect(canvas.getByRole('group', { name: 'Auto Mode options' })).toBeVisible();
  },
};

/** Play test: clicking the main toggle section fires onToggle. */
export const Toggles: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Auto Mode' }));
    await expect(args.onToggle).toHaveBeenCalled();
  },
};
