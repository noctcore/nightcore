import type { Meta, StoryObj } from '@storybook/react-vite';

import { UsageLimitBanner } from './UsageLimitBanner';

const meta = {
  title: 'UI/UsageLimitBanner',
  component: UsageLimitBanner,
  parameters: { layout: 'padded' },
  args: {
    status: 'completed',
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    runNoun: 'review',
  },
} satisfies Meta<typeof UsageLimitBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The signature match: a completed run that spent $0.00 with zero input tokens. */
export const Default: Story = {};

/** The Insight/Scorecard copy variant (a different run noun). */
export const Analysis: Story = { args: { runNoun: 'analysis' } };

/** A run that actually did work renders nothing (the banner self-hides). */
export const HiddenWhenHealthy: Story = {
  args: {
    costUsd: 0.42,
    usage: { inputTokens: 128_400, outputTokens: 18_220 },
  },
};

/** A still-running run never fires the banner (only `completed` does). */
export const HiddenWhileRunning: Story = { args: { status: 'running' } };
