import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { makeTask,SAMPLE_REVIEW_PASS } from '../_fixtures';
import { TaskActionsProvider, type TaskDetailActions } from '../actions';
import { SessionCard } from './SessionCard';
import type { SessionCardProps } from './SessionCard.types';

/** The full grouped-action object with every handler stubbed — stories provide
 *  this through `TaskActionsProvider` so the editable card surfaces its pickers
 *  (the card renders pickers only when every `onChange*` is wired). */
const actions: TaskDetailActions = {
  onSelect: fn(),
  onRun: fn(),
  onCancel: fn(),
  onDelete: fn(),
  onRespondPermission: fn(),
  onAnswerQuestion: fn(),
  onApprove: fn(),
  onReject: fn(),
  onRefine: fn(),
  onChangeKind: fn(),
  onChangeRunMode: fn(),
  onChangePermissionMode: fn(),
  onChangeModel: fn(),
  onChangeEffort: fn(),
  onChangeMaxTurns: fn(),
  onChangeMaxBudget: fn(),
  onAcceptReview: fn(),
  onRejectReview: fn(),
  onRerunVerification: fn(),
  onRunGauntlet: fn(),
  onMerge: fn(),
  onCommit: fn(),
  onResumeSession: fn(),
  onRenameSession: fn(),
  onTagSession: fn(),
};

/** The story fixture: the card wrapped in the `TaskActionsProvider` it now reads
 *  its edit handlers from. `actions` stays a story ARG so plays and tests keep
 *  overriding individual handlers per render. */
function SessionCardFixture({
  actions,
  ...props
}: SessionCardProps & { actions: TaskDetailActions }) {
  return (
    <TaskActionsProvider actions={actions}>
      <SessionCard {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/SessionCard',
  component: SessionCardFixture,
  args: { actions },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionCardFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh backlog task: the card opens by default (editable) so the per-task
 *  pickers surface without a click. */
export const Editable: Story = {
  args: {
    task: makeTask({
      id: 't-edit',
      status: 'backlog',
      title: 'Apply a destructive migration',
      permissionMode: 'plan',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    }),
    kindEditable: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const modes = within(canvas.getByRole('radiogroup', { name: /permission mode/i }));
    await userEvent.click(modes.getByRole('radio', { name: /^ask$/i }));
    await expect(args.actions.onChangePermissionMode).toHaveBeenCalledWith('t-edit', 'ask');

    const turns = canvas.getByRole('spinbutton', { name: 'Max turns' });
    await userEvent.type(turns, '40');
    await userEvent.tab();
    await expect(args.actions.onChangeMaxTurns).toHaveBeenCalledWith('t-edit', 40);
  },
};

/** A done (read-only) task: the card starts collapsed to its middot summary line;
 *  clicking expands it to the read-only config pills. */
export const Readonly: Story = {
  args: {
    task: makeTask({
      id: 't-readonly',
      status: 'done',
      title: 'Wire up auth guard',
      summary: 'Added the auth middleware and covered it with tests.',
      runMode: 'worktree',
      permissionMode: 'bypass',
      model: 'claude-opus-4-8',
      effort: 'high',
      maxTurns: 40,
      branch: 'nc/auth-guard',
      verified: true,
      committed: true,
      review: SAMPLE_REVIEW_PASS,
    }),
    kindEditable: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: /worktree/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  },
};
