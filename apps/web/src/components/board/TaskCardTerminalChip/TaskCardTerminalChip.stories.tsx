import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { fn } from 'storybook/test';

import { linkTaskToSession, resetTerminalLinksForTest } from '@/lib/terminal-links';

import { makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { TaskCardTerminalChip } from './TaskCardTerminalChip';
import type { TaskCardTerminalChipProps } from './TaskCardTerminalChip.types';

/** Seed a link so the chip renders, wrapped in the actions provider it reads from. */
function ChipFixture({ taskId, linked }: TaskCardTerminalChipProps & { linked: boolean }) {
  useEffect(() => {
    resetTerminalLinksForTest();
    if (linked) linkTaskToSession(taskId, 'session-1');
    return () => resetTerminalLinksForTest();
  }, [taskId, linked]);
  return (
    <TaskActionsProvider actions={makeTaskActions({ onOpenTerminal: fn() })}>
      <TaskCardTerminalChip taskId={taskId} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/TaskCardTerminalChip',
  component: ChipFixture,
  args: { taskId: 'task-1', linked: true },
} satisfies Meta<typeof ChipFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A task with a linked live terminal — the chip shows. */
export const Linked: Story = {};

/** No linked terminal — the chip renders nothing. */
export const Unlinked: Story = {
  args: { linked: false },
};
