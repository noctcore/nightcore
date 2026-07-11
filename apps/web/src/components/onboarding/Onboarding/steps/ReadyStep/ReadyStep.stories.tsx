import type { Meta, StoryObj } from '@storybook/react-vite';

import { MOCK_ONBOARDING_PREREQUISITES } from '@/lib/bridge';

import { ReadyStep } from './ReadyStep';

const meta = {
  title: 'Onboarding/Steps/ReadyStep',
  component: ReadyStep,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[520px] bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: { checks: MOCK_ONBOARDING_PREREQUISITES },
} satisfies Meta<typeof ReadyStep>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Everything ready — the all-green launch checklist. */
export const Default: Story = {};

/** GitHub CLI not connected: the optional line reads "skipped" (never a failure —
 *  it doesn't block launch), while the required lines stay green. */
export const GithubSkipped: Story = {
  args: {
    checks: {
      ...MOCK_ONBOARDING_PREREQUISITES,
      gh: { ...MOCK_ONBOARDING_PREREQUISITES.gh, installed: false, authenticated: null },
    },
  },
};
