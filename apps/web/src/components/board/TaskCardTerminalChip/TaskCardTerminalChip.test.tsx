import { userEvent } from '@vitest/browser/context';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { linkTaskToSession, resetTerminalLinksForTest } from '@/lib/terminal-links';

import { makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { TaskCardTerminalChip } from './TaskCardTerminalChip';

afterEach(() => resetTerminalLinksForTest());

function setup(taskId: string, onOpenTerminal = vi.fn()) {
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions({ onOpenTerminal })}>
      <TaskCardTerminalChip taskId={taskId} />
    </TaskActionsProvider>,
  );
  return { screen, onOpenTerminal };
}

test('renders nothing when no terminal is linked', () => {
  const { screen } = setup('task-1');
  expect(screen.container.querySelector('button')).toBeNull();
});

test('shows the chip and opens the linked terminal on click', async () => {
  linkTaskToSession('task-1', 'session-9');
  const { screen, onOpenTerminal } = setup('task-1');
  await userEvent.click(screen.getByRole('button', { name: 'Open linked terminal' }));
  expect(onOpenTerminal).toHaveBeenCalledWith('session-9');
});
