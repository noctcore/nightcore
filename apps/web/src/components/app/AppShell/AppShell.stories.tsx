import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@/components/ui';
import { AppShell } from './AppShell';

/** The full app shell. In Storybook the bridge runs in browser mode, so it seeds
 *  from mock data (one project, default settings) and commands no-op. The shell's
 *  hooks read the toast channel, so the provider wraps it here too. */
const meta = {
  title: 'App/AppShell',
  component: AppShell,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div style={{ height: '100vh' }}>
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
