import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { Column } from './Column';
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
    <TaskActionsProvider actions={makeTaskActions()}>
      <Column
        title="Backlog"
        tasks={[]}
        dotColor="oklch(62% .02 290)"
        selectedId={null}
        blockedIds={new Set()}
        logCounts={{}}
        dropStatus="backlog"
        emptyText="Add a task to begin"
      />
    </TaskActionsProvider>,
  );
  const shell = screen.container.querySelector('[aria-dropeffect]');
  expect(shell?.getAttribute('aria-dropeffect')).toBe('move');
});

test('the In Progress column is not a drop target (run-only)', async () => {
  const screen = render(
    <TaskActionsProvider actions={makeTaskActions()}>
      <Column
        title="In Progress"
        tasks={[TASKS_BY_STATUS.in_progress]}
        dotColor="oklch(80% .14 75)"
        selectedId={null}
        blockedIds={new Set()}
        logCounts={{}}
        dropStatus="in_progress"
      />
    </TaskActionsProvider>,
  );
  const shell = screen.container.querySelector('[aria-dropeffect]');
  expect(shell?.getAttribute('aria-dropeffect')).toBe('none');
});

test('a foreign-card stream flush re-renders only the card whose count changed', async () => {
  // The transform-to-primitives contract: `logCounts` arrives as a FRESH object
  // per `nc:session` delta (the column re-renders), but each memoized TaskCard
  // reads only its own primitive `logCount` — so a flush on card A must not
  // re-render card B. `isActionPending` is the probe: every card calls it during
  // render (the per-status pending checks), so B's call count staying flat across
  // the flush proves its memo bailed. The provider value is hoisted ONCE — a
  // fresh actions object per render would re-render every consumer and void the
  // memo economy this test pins.
  const isActionPending = vi.fn<(action: string, id: string) => boolean>(() => false);
  const actions = makeTaskActions({ isActionPending });
  const taskA = TASKS_BY_STATUS.in_progress; // 't-running' — the streaming card
  const taskB = TASKS_BY_STATUS.ready; // 't-ready' — the bystander
  const tasks = [taskA, taskB];
  const blockedIds = new Set<string>();
  const column = (logCounts: Record<string, number>) => (
    <TaskActionsProvider actions={actions}>
      <Column
        title="Mixed"
        tasks={tasks}
        dotColor="oklch(80% .14 75)"
        selectedId={null}
        blockedIds={blockedIds}
        logCounts={logCounts}
        dropStatus="backlog"
      />
    </TaskActionsProvider>
  );
  const callsFor = (id: string): number =>
    isActionPending.mock.calls.filter(([, taskId]) => taskId === id).length;

  const screen = render(column({ [taskA.id]: 1 }));
  await expect.element(screen.getByText('Add dark-mode toggle')).toBeInTheDocument();
  const aBefore = callsFor(taskA.id);
  const bBefore = callsFor(taskB.id);
  expect(bBefore).toBeGreaterThan(0);

  // The flush: a brand-new logCounts object where only card A's count advanced.
  screen.rerender(column({ [taskA.id]: 2 }));
  await vi.waitFor(() => expect(callsFor(taskA.id)).toBeGreaterThan(aBefore));
  // Card B's memo bailed — its render-time pending probes never ran again.
  expect(callsFor(taskB.id)).toBe(bBefore);
});

test('a running card in the In Progress column is not draggable (pinned)', async () => {
  const screen = render(<InProgress />);
  await expect.element(screen.getByText('Generate API client')).toBeInTheDocument();
  // A live run owns its card — no grab affordance, no @dnd-kit drag handle.
  expect(screen.container.querySelector('.cursor-grab')).toBeNull();
});
