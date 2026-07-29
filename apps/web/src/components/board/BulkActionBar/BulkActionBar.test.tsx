import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTask, makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { EMPTY_RUN_ORDER, RunOrderProvider } from '../run-order';
import { TaskSelectionProvider } from '../selection';
import { BulkActionBar } from './BulkActionBar';
import * as stories from './BulkActionBar.stories';

const { AlreadyChained, Hidden, NoFreeSlots, OneSelected, ThreeSelected } =
  composeStories(stories);

const BOARD = [
  makeTask({ id: 'one', title: 'Extract the settings store', createdAt: 10 }),
  makeTask({ id: 'two', title: 'Add the rate limiter', createdAt: 20 }),
];

test('renders nothing when nothing is selected', () => {
  const screen = render(<Hidden />);
  expect(screen.container.querySelector('[role="toolbar"]')).toBeNull();
});

test('announces the selection count and exposes the verbs as a toolbar', async () => {
  const screen = render(<ThreeSelected />);
  await expect
    .element(screen.getByRole('toolbar', { name: /bulk task actions/i }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('3 tasks selected')).toBeInTheDocument();
});

test('Chain explains itself rather than vanishing when only one task is selected', async () => {
  const screen = render(<OneSelected />);
  const chain = screen.getByRole('button', { name: /^chain$/i });
  await expect.element(chain).toHaveAttribute('aria-disabled', 'true');
  // `toHaveAttribute` compares by equality, so match the substring explicitly.
  await expect
    .element(chain)
    .toHaveAttribute('title', expect.stringContaining('at least two tasks'));
});

test('an already-chained selection inerts Chain and arms Unchain', async () => {
  const screen = render(<AlreadyChained />);
  await expect
    .element(screen.getByRole('button', { name: /^chain$/i }))
    .toHaveAttribute('title', expect.stringContaining('Already chained'));
  await expect
    .element(screen.getByRole('button', { name: /^unchain$/i }))
    .toHaveAttribute('aria-disabled', 'false');
});

test('Run is refused with the real slot reason instead of firing rejected runs', async () => {
  const screen = render(<NoFreeSlots />);
  const run = screen.getByRole('button', { name: /^run$/i });
  await expect.element(run).toHaveAttribute('aria-disabled', 'true');
  await expect.element(run).toHaveAttribute('title', expect.stringContaining('run slot'));
});

test('Unchain drops only the edges INSIDE the selection', async () => {
  const onChangeDependencies = vi.fn();
  // `two` waits on `one` (in the selection) AND on `outside` (not selected).
  const tasks = [
    BOARD[0]!,
    makeTask({
      id: 'two',
      title: 'Add the rate limiter',
      createdAt: 20,
      dependencies: ['one', 'outside'],
    }),
  ];
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions({ onChangeDependencies })}>
      <RunOrderProvider value={{ ...EMPTY_RUN_ORDER, freeSlots: 3, maxConcurrency: 3 }}>
        <TaskSelectionProvider
          value={{
            selectedIds: new Set(['one', 'two']),
            toggle: () => {},
            clear: () => {},
            select: () => {},
          }}
        >
          <BulkActionBar tasks={tasks} onMoveTask={() => {}} />
        </TaskSelectionProvider>
      </RunOrderProvider>
    </TaskActionsProvider>,
  );

  await userEvent.click(screen.getByRole('button', { name: /^unchain$/i }));
  expect(onChangeDependencies).toHaveBeenCalledTimes(1);
  expect(onChangeDependencies).toHaveBeenCalledWith('two', ['outside']);
});

test('keyboard path: Clear selection is reachable and activates', async () => {
  const clear = vi.fn();
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions()}>
      <RunOrderProvider value={{ ...EMPTY_RUN_ORDER, freeSlots: 3, maxConcurrency: 3 }}>
        <TaskSelectionProvider
          value={{ selectedIds: new Set(['one']), toggle: () => {}, clear, select: () => {} }}
        >
          <BulkActionBar tasks={BOARD} onMoveTask={() => {}} />
        </TaskSelectionProvider>
      </RunOrderProvider>
    </TaskActionsProvider>,
  );
  const button = screen.getByRole('button', { name: /clear selection/i });
  await expect.element(button).toBeInTheDocument();
  await userEvent.click(button);
  await userEvent.keyboard('{Enter}');
  expect(clear).toHaveBeenCalled();
});
