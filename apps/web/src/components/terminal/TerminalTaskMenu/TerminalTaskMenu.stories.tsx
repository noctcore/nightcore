import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { makeTerminalSession, makeTerminalTask } from '../_fixtures';
import { TerminalTaskMenu } from './TerminalTaskMenu';

const TASKS = [
  makeTerminalTask({ id: 't-1', title: 'Add dark-mode toggle', updatedAt: 3 }),
  makeTerminalTask({ id: 't-2', title: 'Fix flaky login test', updatedAt: 2 }),
  makeTerminalTask({ id: 't-3', title: 'Migrate build to Vite', updatedAt: 1 }),
];

const meta = {
  title: 'Terminal/TerminalTaskMenu',
  component: TerminalTaskMenu,
  args: {
    tasks: TASKS,
    activeSession: makeTerminalSession({ id: 'session-1' }),
    onPick: fn(),
  },
} satisfies Meta<typeof TerminalTaskMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The dropdown over a live terminal with a few pre-run tasks. */
export const Default: Story = {};

/** No pre-run tasks — the menu shows a single inert row. */
export const NoTasks: Story = {
  args: { tasks: [] },
};

/** No active terminal — the trigger is disabled. */
export const NoActiveTerminal: Story = {
  args: { activeSession: null },
};
