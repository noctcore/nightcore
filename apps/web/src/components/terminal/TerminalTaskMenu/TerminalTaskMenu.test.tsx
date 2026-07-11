import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTerminalSession, makeTerminalTask } from '../_fixtures';
import { TerminalTaskMenu } from './TerminalTaskMenu';

const SESSION = makeTerminalSession({ id: 'session-1' });
const TASKS = [
  makeTerminalTask({ id: 't-1', title: 'Add dark-mode toggle' }),
  makeTerminalTask({ id: 't-2', title: 'Fix flaky login test' }),
];

test('picking a task injects it into the active session', async () => {
  const onPick = vi.fn();
  const screen = render(
    <TerminalTaskMenu tasks={TASKS} activeSession={SESSION} onPick={onPick} />,
  );
  await userEvent.click(screen.getByRole('button', { name: /inject task/i }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Fix flaky login test' }));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick).toHaveBeenCalledWith(SESSION, TASKS[1]);
});

test('the trigger is disabled with no active terminal', async () => {
  const onPick = vi.fn();
  const screen = render(<TerminalTaskMenu tasks={TASKS} activeSession={null} onPick={onPick} />);
  const trigger = screen.getByRole('button', { name: /inject task/i });
  await expect.element(trigger).toBeDisabled();
});

test('an empty task list shows a single inert row', async () => {
  const onPick = vi.fn();
  const screen = render(<TerminalTaskMenu tasks={[]} activeSession={SESSION} onPick={onPick} />);
  await userEvent.click(screen.getByRole('button', { name: /inject task/i }));
  await expect.element(screen.getByRole('menuitem', { name: 'No backlog tasks' })).toBeVisible();
  expect(onPick).not.toHaveBeenCalled();
});
