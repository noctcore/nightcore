import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@/components/ui';
import { HarnessView } from './HarnessView';

const meta = {
  title: 'Harness/HarnessView',
  component: HarnessView,
  parameters: { layout: 'fullscreen' },
  // The view's hooks surface convention/artifact-action failures through the toast
  // channel, so the provider wraps it here just as it does in the app.
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
} satisfies Meta<typeof HarnessView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Outside Tauri the bridge returns its fallbacks (no runs, a no-op event
// listener), so this renders the idle project view.
export const Idle: Story = {};

export const NoProject: Story = {
  args: { projectPath: null, projectName: null },
};
