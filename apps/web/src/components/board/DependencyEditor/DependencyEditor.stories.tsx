import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { makeTask, makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider, type TaskDetailActions } from '../actions';
import { DependencyEditor } from './DependencyEditor';
import type { DependencyEditorProps } from './DependencyEditor.types';

/** The story fixture: the editor wrapped in the `TaskActionsProvider` it reads its
 *  commit handler from. The handler stays a story ARG so plays assert on it. */
function DependencyEditorFixture({
  onChangeDependencies,
  ...props
}: DependencyEditorProps & Pick<Partial<TaskDetailActions>, 'onChangeDependencies'>) {
  return (
    <TaskActionsProvider actions={makeTaskActions({ onChangeDependencies })}>
      <DependencyEditor {...props} />
    </TaskActionsProvider>
  );
}

/** A small board: two settled tasks plus the subject, so the picker has candidates. */
const BOARD = [
  makeTask({ id: 'dep-done', title: 'Generate the API client', status: 'done', createdAt: 10 }),
  makeTask({ id: 'dep-open', title: 'Add the rate limiter', status: 'backlog', createdAt: 20 }),
  makeTask({ id: 'subject', title: 'Worktree cleanup policy', status: 'backlog', createdAt: 30 }),
];

const meta = {
  title: 'Board/DependencyEditor',
  component: DependencyEditorFixture,
  args: { onChangeDependencies: fn() },
  decorators: [
    (Story) => (
      <div style={{ width: 380 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DependencyEditorFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No dependencies yet — the empty note explains what adding one buys you. */
export const NoDependencies: Story = {
  args: { task: BOARD[2]!, tasks: BOARD },
};

/** One satisfied (Done) and one still-open dependency — the two row tones. */
export const MixedDependencies: Story = {
  args: {
    task: makeTask({
      id: 'subject',
      title: 'Worktree cleanup policy',
      status: 'backlog',
      createdAt: 30,
      dependencies: ['dep-done', 'dep-open'],
    }),
    tasks: BOARD,
  },
};

/** A dangling dependency (its task was deleted) — the coordinator fails CLOSED on it, so
 *  the editor surfaces it loudly rather than hiding it. */
export const DanglingDependency: Story = {
  args: {
    task: makeTask({ id: 'subject', status: 'backlog', dependencies: ['vanished'] }),
    tasks: BOARD,
  },
};

/** Read-only (a running task) — the rows render without remove buttons or the picker. */
export const ReadOnly: Story = {
  args: {
    task: makeTask({
      id: 'subject',
      status: 'in_progress',
      dependencies: ['dep-done'],
    }),
    tasks: BOARD,
    editable: false,
  },
};

/** Play test: picking a candidate commits the appended dependency list. */
export const AddsADependency: Story = {
  args: { task: BOARD[2]!, tasks: BOARD },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /add dependency/i }));
    await userEvent.click(canvas.getByRole('button', { name: /add the rate limiter/i }));
    await expect(args.onChangeDependencies).toHaveBeenCalledWith('subject', ['dep-open']);
  },
};

/** Play test: removing a row commits the shortened list. */
export const RemovesADependency: Story = {
  args: {
    task: makeTask({ id: 'subject', status: 'backlog', dependencies: ['dep-done', 'dep-open'] }),
    tasks: BOARD,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: /remove dependency generate the api client/i }),
    );
    await expect(args.onChangeDependencies).toHaveBeenCalledWith('subject', ['dep-open']);
  },
};

/** A candidate that would close a cycle stays VISIBLE but disabled — hiding it would send
 *  the user hunting for a task that is right there. */
export const CycleCandidateDisabled: Story = {
  args: {
    task: makeTask({ id: 'subject', title: 'Second link', status: 'backlog', createdAt: 30 }),
    tasks: [
      makeTask({ id: 'subject', title: 'Second link', status: 'backlog', createdAt: 30 }),
      makeTask({
        id: 'downstream',
        title: 'Third link',
        status: 'backlog',
        createdAt: 40,
        dependencies: ['subject'],
      }),
      TASKS_BY_STATUS.ready,
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /add dependency/i }));
    await expect(canvas.getByRole('button', { name: /third link/i })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: /add dark-mode toggle/i })).toBeEnabled();
  },
};
