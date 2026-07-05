import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';

import { PrReviewView } from './PrReviewView';

const meta = {
  title: 'PrReview/PrReviewView',
  component: PrReviewView,
  parameters: { layout: 'fullscreen' },
  // The view's hooks surface finding-action + post-review failures through the
  // toast channel, so the provider wraps it here just as it does in the app.
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
} satisfies Meta<typeof PrReviewView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Outside Tauri the bridge returns its fallbacks (no PRs, no runs, a no-op
// event listener), so this renders the empty two-panel workspace.
export const Idle: Story = {};

export const NoProject: Story = {
  args: { projectPath: null, projectName: null },
};
