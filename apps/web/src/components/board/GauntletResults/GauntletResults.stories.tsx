import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import {
  GAUNTLET_FAILED,
  GAUNTLET_PASSED,
  STRUCTURE_LOCK_FAILED,
  STRUCTURE_LOCK_PASSED,
} from '../_fixtures';
import { GauntletResults } from './GauntletResults';

const meta = {
  title: 'Board/GauntletResults',
  component: GauntletResults,
  args: {
    result: null,
    running: false,
    onRun: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GauntletResults>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotRunYet: Story = {};

export const Running: Story = { args: { running: true } };

export const Passed: Story = { args: { result: GAUNTLET_PASSED } };

export const Failed: Story = { args: { result: GAUNTLET_FAILED } };

/** Both gates green — the readiness gauntlet and the project's own Structure-Lock
 *  harness checks all pass. */
export const StructureLockPassed: Story = {
  args: { result: GAUNTLET_PASSED, structureLock: STRUCTURE_LOCK_PASSED },
};

/** The Structure-Lock Gauntlet failed at its generated lint plugin; the later
 *  boundary check is skipped (stop-at-first). */
export const StructureLockFailed: Story = {
  args: { result: GAUNTLET_PASSED, structureLock: STRUCTURE_LOCK_FAILED },
};

/** Play test: "Run checks" triggers the run handler. */
export const RunsChecks: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /run checks/i }));
    await expect(args.onRun).toHaveBeenCalled();
  },
};
