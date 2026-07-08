import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';

import { Onboarding } from './Onboarding';

const meta = {
  title: 'Onboarding/Onboarding',
  component: Onboarding,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div className="h-screen">
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
  args: {
    folder: null,
    gitState: 'unknown',
    onChooseFolder: fn(),
    onInitGit: fn(),
    onCreateProject: fn(async () => {}),
    onSkip: fn(),
    onComplete: fn(),
  },
} satisfies Meta<typeof Onboarding>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstRun: Story = {};

export const FolderSelected: Story = {
  args: {
    folder: '/Users/shirone/Documents/Projects/nightcore',
    gitState: 'valid',
  },
};
