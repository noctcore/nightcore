import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { PortableLockExportButton } from './PortableLockExportButton';

const meta = {
  title: 'UI/PortableLockExportButton',
  component: PortableLockExportButton,
  parameters: { layout: 'centered' },
  args: {
    projectPath: '/proj',
  },
} satisfies Meta<typeof PortableLockExportButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Enabled: the active-project trigger. Clicking opens the preview/confirm dialog
 *  (the browser preview has no Tauri backend, so confirming shows the unavailable
 *  note rather than writing anything). */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /export portable lock/i }));
    // The dialog (portaled to body) opens — its heading appears.
    await expect(
      within(document.body).getByRole('heading', { name: /export portable lock/i }),
    ).toBeInTheDocument();
  },
};

/** No active project — the trigger is disabled and cannot open the dialog. */
export const Disabled: Story = {
  args: { projectPath: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: /export portable lock/i }),
    ).toBeDisabled();
  },
};
