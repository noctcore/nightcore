import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { GauntletResults } from './GauntletResults';
import { GAUNTLET_FAILED, GAUNTLET_PASSED } from '../_fixtures';

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

/** Play test: "Run checks" triggers the run handler. */
export const RunsChecks: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /run checks/i }));
    await expect(args.onRun).toHaveBeenCalled();
  },
};
