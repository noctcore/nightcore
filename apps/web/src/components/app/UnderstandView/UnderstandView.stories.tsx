import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';

import { UnderstandView } from './UnderstandView';

const meta = {
  title: 'App/UnderstandView',
  component: UnderstandView,
  parameters: { layout: 'fullscreen' },
  // The shell mounts InsightView / ScorecardView, whose hooks surface item-action
  // failures through the toast channel — so the provider wraps it here just as it
  // does in the app (and in each inner view's own story).
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
    onGotoBoard: fn(),
  },
} satisfies Meta<typeof UnderstandView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Outside Tauri the bridge returns its fallbacks (no runs, a no-op event
// listener), so this renders the idle Find lens (Insight) with the toggle above.
export const Idle: Story = {};

export const NoProject: Story = {
  args: { projectPath: null, projectName: null },
};
