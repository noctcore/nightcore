import type { Meta, StoryObj } from '@storybook/react-vite';

import { StagesStep } from './StagesStep';

const meta = {
  title: 'Onboarding/Steps/StagesStep',
  component: StagesStep,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[640px] bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StagesStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
