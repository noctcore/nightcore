import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { IssueMapExportButton } from './IssueMapExportButton';

const meta = {
  title: 'UI/IssueMapExportButton',
  component: IssueMapExportButton,
  parameters: { layout: 'centered' },
  args: {
    scanKind: 'insight',
    runId: 'run-abc',
  },
} satisfies Meta<typeof IssueMapExportButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Enabled: the completed-run trigger. Clicking opens the IssueMapDialog. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /export to github/i }));
    // The dialog (portaled to body) opens — its heading appears.
    await expect(
      within(document.body).getByRole('heading', { name: /export to github/i }),
    ).toBeInTheDocument();
  },
};

/** No completed run yet — the trigger is disabled and cannot open the dialog. */
export const Disabled: Story = {
  args: { runId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /export to github/i })).toBeDisabled();
  },
};
