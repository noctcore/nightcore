import type { Meta, StoryObj } from '@storybook/react-vite';

import { RunUsageLine } from './RunUsageLine';

const meta = {
  title: 'UI/RunUsageLine',
  component: RunUsageLine,
  parameters: { layout: 'centered' },
  args: {
    model: 'claude-opus-4-8',
    costUsd: 0.42,
    usage: { inputTokens: 128_400, outputTokens: 18_220 },
    durationMs: 74_000,
  },
} satisfies Meta<typeof RunUsageLine>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The full readout — model, approximate cost, tokens, duration. */
export const Default: Story = {};

/** A run whose model fell back to the config default. */
export const DefaultModel: Story = { args: { model: null } };

/** A $0 / zero-token run (the usage-limit signature) still renders cleanly. */
export const NoUsage: Story = {
  args: {
    model: 'claude-opus-4-8',
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
  },
};
