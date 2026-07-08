import type { Meta, StoryObj } from '@storybook/react-vite';

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
} satisfies Meta<typeof ReadyStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
