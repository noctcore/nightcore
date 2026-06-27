import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { Column } from './Column';
import { TASKS_BY_STATUS } from '../_fixtures';
import * as stories from './Column.stories';

const { Empty, InProgress, WaitingApproval, Verified } = composeStories(stories);

test('shows the custom empty placeholder when a column has no tasks', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Add a task to begin')).toBeInTheDocument();
});

test('renders the task title for a populated column', async () => {
  const screen = render(<InProgress />);
  await expect.element(screen.getByText('Generate API client')).toBeInTheDocument();
});

test('renders the roadmap badge beside the column title', async () => {
  const screen = render(<WaitingApproval />);
  await expect.element(screen.getByText('M3')).toBeInTheDocument();
});

test('fires onClear from a clearable, non-empty column', async () => {
  const onClear = vi.fn();
  const screen = render(<Verified onClear={onClear} />);
  await screen.getByRole('button', { name: /clear/i }).click();
  expect(onClear).toHaveBeenCalled();
});

test('a droppable column advertises itself as a move target', async () => {
  const screen = render(
    <Column
      title="Backlog"
      tasks={[]}
      dotColor="oklch(62% .02 290)"
      selectedId={null}
      blockedIds={new Set()}
      logCounts={{}}
      dropStatus="backlog"
      emptyText="Add a task to begin"
      onSelect={vi.fn()}
      onMoveTask={vi.fn()}
    />,
  );
  const shell = screen.container.querySelector('[aria-dropeffect]');
  expect(shell?.getAttribute('aria-dropeffect')).toBe('move');
});

test('the In Progress column is not a drop target (run-only)', async () => {
  const screen = render(
    <Column
      title="In Progress"
      tasks={[TASKS_BY_STATUS.in_progress]}
      dotColor="oklch(80% .14 75)"
      selectedId={null}
      blockedIds={new Set()}
      logCounts={{}}
      dropStatus="in_progress"
      onSelect={vi.fn()}
      onMoveTask={vi.fn()}
    />,
  );
  const shell = screen.container.querySelector('[aria-dropeffect]');
  expect(shell?.getAttribute('aria-dropeffect')).toBe('none');
});

test('a running card in the In Progress column is not draggable (pinned)', async () => {
  const screen = render(<InProgress />);
  await expect.element(screen.getByText('Generate API client')).toBeInTheDocument();
  // A live run owns its card — no grab affordance, no @dnd-kit drag handle.
  expect(screen.container.querySelector('.cursor-grab')).toBeNull();
});
