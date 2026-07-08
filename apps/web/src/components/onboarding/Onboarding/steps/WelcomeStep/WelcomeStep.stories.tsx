import type { Meta, StoryObj } from '@storybook/react-vite';

import { WelcomeStep } from './WelcomeStep';

const meta = {
  title: 'Onboarding/Steps/WelcomeStep',
  component: WelcomeStep,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[520px] bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WelcomeStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
