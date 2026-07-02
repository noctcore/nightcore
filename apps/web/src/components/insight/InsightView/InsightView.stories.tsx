import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';

import { InsightView } from './InsightView';

const meta = {
  title: 'Insight/InsightView',
  component: InsightView,
  parameters: { layout: 'fullscreen' },
  // The view's hooks surface finding-action failures through the toast channel,
  // so the provider wraps it here just as it does in the app (and in AppShell's
  // story).
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
} satisfies Meta<typeof InsightView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Outside Tauri the bridge returns its fallbacks (no runs, a no-op event
// listener), so this renders the idle project view.
export const Idle: Story = {};

export const NoProject: Story = {
  args: { projectPath: null, projectName: null },
};
