import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToastProvider } from '@/components/ui';

import { CouncilView } from './CouncilView';

const meta = {
  title: 'Council/CouncilView',
  component: CouncilView,
  parameters: { layout: 'fullscreen' },
  // The view surfaces start/kill failures through the toast channel, so the provider
  // wraps it here just as it does in the app (mirroring IssueTriageView's story).
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
  args: {
    projectPath: '/Users/dev/acme',
    projectName: 'acme',
  },
} satisfies Meta<typeof CouncilView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Outside Tauri the bridge returns its fallbacks (a no-op nc:debate listener, a no-op
// start_council), so this renders the idle start panel.
export const Idle: Story = {};

export const NoProject: Story = {
  args: { projectPath: null, projectName: null },
};
