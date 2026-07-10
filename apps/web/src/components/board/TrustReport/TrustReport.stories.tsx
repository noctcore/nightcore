import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import {
  makeTask,
  TRUST_DENIALS,
  TRUST_EMPTY,
  TRUST_GAUNTLET_FAILED,
  TRUST_VERIFIED,
} from '../_fixtures';
import { TrustReport } from './TrustReport';

const meta = {
  title: 'Board/TrustReport',
  component: TrustReport,
  args: {
    task: makeTask({
      id: 'task-1',
      title: 'Wire up auth guard',
      status: 'done',
      runMode: 'worktree',
      branch: 'nc/auth-guard',
      verified: true,
    }),
    trustReport: TRUST_VERIFIED,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrustReport>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The demoable happy path: reviewer PASS, structure-lock green, a couple of
 *  guardrail events, cost + tokens present. */
export const Verified: Story = {};

/** The gauntlet failed at a structure-lock check and the reviewer requested
 *  changes — the "do not trust this merge yet" shape. */
export const GauntletFailed: Story = { args: { trustReport: TRUST_GAUNTLET_FAILED } };

/** Denied + asked guardrail actions plus a policy hold — the full guardrail
 *  history. */
export const Denials: Story = { args: { trustReport: TRUST_DENIALS } };

/** An in-progress task with no gauntlet/guardrail/flight signal yet — each section
 *  renders its quiet empty note rather than a wall of zeroes. */
export const Empty: Story = {
  args: {
    task: makeTask({ id: 'task-empty', title: 'Draft the settings store', status: 'in_progress' }),
    trustReport: TRUST_EMPTY,
  },
};

/** The outside-Tauri sentinel (browser preview): the band shows its quiet
 *  unavailable note instead of a broken fetch. */
export const Unavailable: Story = { args: { trustReport: null } };

/** Play test: the Preview toggle reveals the canonical-markdown container. */
export const TogglesPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^preview$/i }));
    await expect(canvas.getByRole('button', { name: /hide preview/i })).toBeInTheDocument();
  },
};
