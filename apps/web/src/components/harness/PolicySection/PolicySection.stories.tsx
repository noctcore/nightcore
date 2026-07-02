import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@/components/ui';
import { PolicySection } from './PolicySection';

/** Outside Tauri the bridge resolves the mock policy, so the section renders the
 *  populated editor + the pre-scan injection card. */
const meta = {
  title: 'Harness/PolicySection',
  component: PolicySection,
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof PolicySection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
