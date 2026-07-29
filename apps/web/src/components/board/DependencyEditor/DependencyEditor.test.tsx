import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTask, makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { DependencyEditor } from './DependencyEditor';
import * as stories from './DependencyEditor.stories';

const { DanglingDependency, MixedDependencies, NoDependencies, ReadOnly } =
  composeStories(stories);

const BOARD = [
  makeTask({ id: 'dep-done', title: 'Generate the API client', status: 'done', createdAt: 10 }),
  makeTask({ id: 'dep-open', title: 'Add the rate limiter', status: 'backlog', createdAt: 20 }),
  makeTask({ id: 'subject', title: 'Worktree cleanup policy', status: 'backlog', createdAt: 30 }),
];

test('explains what a dependency does when the task declares none', async () => {
  const screen = render(<NoDependencies />);
  await expect
    .element(screen.getByText(/add a dependency to hold it until another task finishes/i))
    .toBeInTheDocument();
});

test('renders satisfied and unsatisfied dependency rows by title', async () => {
  const screen = render(<MixedDependencies />);
  await expect.element(screen.getByText('Generate the API client')).toBeInTheDocument();
  await expect.element(screen.getByText('Add the rate limiter')).toBeInTheDocument();
});

test('surfaces a dangling dependency as a permanent blocker (the backend fails closed)', async () => {
  const screen = render(<DanglingDependency />);
  await expect
    .element(screen.getByText(/deleted task — blocks this run forever/i))
    .toBeInTheDocument();
});

test('read-only mode offers no remove button and no picker', () => {
  const screen = render(<ReadOnly />);
  expect(screen.container.querySelector('[aria-label^="Remove dependency"]')).toBeNull();
  expect(screen.container.textContent).not.toMatch(/add dependency/i);
});

test('the picker filter narrows the candidate list', async () => {
  const onChangeDependencies = vi.fn();
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions({ onChangeDependencies })}>
      <DependencyEditor task={BOARD[2]!} tasks={BOARD} />
    </TaskActionsProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /add dependency/i }));
  // 'limiter', not 'rate' — "Gene*rate* the API client" would match that substring too.
  await userEvent.fill(screen.getByLabelText(/filter tasks to depend on/i), 'limiter');

  await expect.element(screen.getByRole('button', { name: /add the rate limiter/i })).toBeVisible();
  // The controlled filter re-renders asynchronously, so poll rather than reading the
  // container once (a bare read races the commit and passes/fails at random).
  await vi.waitFor(() =>
    expect(screen.container.textContent ?? '').not.toMatch(/generate the api client/i),
  );
});

test('keyboard path: the picker toggle and a candidate are reachable and activate', async () => {
  const onChangeDependencies = vi.fn();
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions({ onChangeDependencies })}>
      <DependencyEditor task={BOARD[2]!} tasks={BOARD} />
    </TaskActionsProvider>,
  );
  const toggle = screen.getByRole('button', { name: /add dependency/i });
  await expect.element(toggle).toBeInTheDocument();
  await userEvent.click(toggle);

  // Tab from the filter input onto the first candidate row, then activate it.
  await userEvent.click(screen.getByLabelText(/filter tasks to depend on/i));
  await userEvent.keyboard('{Tab}');
  await userEvent.keyboard('{Enter}');
  expect(onChangeDependencies).toHaveBeenCalledWith('subject', ['dep-done']);
});

test('never offers the task itself as its own dependency', async () => {
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions({ onChangeDependencies: vi.fn() })}>
      <DependencyEditor task={BOARD[2]!} tasks={BOARD} />
    </TaskActionsProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /add dependency/i }));
  expect(screen.container.textContent).not.toMatch(/worktree cleanup policy/i);
});
