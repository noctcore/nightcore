import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from '../Button';
import { HistoryIcon, RetryIcon } from '../icons';
import { RunLifecycleShell } from './RunLifecycleShell';

const actions = (
  <>
    <Button variant="ghost">
      <HistoryIcon size={14} />
      History
    </Button>
    <Button variant="ghost">
      <RetryIcon size={14} />
      New run
    </Button>
  </>
);

const summary = <span>⌖ opus-4.8 · high · 8 lenses</span>;

const body = (
  <div className="px-6 py-8 text-sm text-muted-foreground">Screen body goes here.</div>
);

const meta = {
  title: 'UI/RunLifecycleShell',
  component: RunLifecycleShell,
  args: {
    title: 'Harness',
    subtitle: 'nightcore',
    phase: 'configure',
    actions,
    summary,
    children: body,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 880, height: 360 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunLifecycleShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** CONFIGURE — no collapsed summary bar (it's the form screen). */
export const Configure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Harness')).toBeVisible();
    await expect(canvas.queryByText(/8 lenses/)).toBeNull();
  },
};

/** RUNNING — the collapsed summary bar is shown below the header. */
export const Running: Story = {
  args: { phase: 'running' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/8 lenses/)).toBeVisible();
  },
};

/** RESULTS — summary bar persists; actions offer History + New run. */
export const Results: Story = {
  args: { phase: 'results' },
};

/** No actions / no subtitle — both slots collapse cleanly. */
export const Minimal: Story = {
  args: { subtitle: undefined, actions: undefined, summary: undefined, phase: 'running' },
};
