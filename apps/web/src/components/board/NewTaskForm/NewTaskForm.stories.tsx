import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { NewTaskForm } from './NewTaskForm';

const meta = {
  title: 'Board/NewTaskForm',
  component: NewTaskForm,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    onCreate: fn(async () => {}),
    onClose: fn(),
  },
} satisfies Meta<typeof NewTaskForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Play test: the create button is gated on a title, then fires onCreate with
 *  the default `build` kind. */
export const CreatesTask: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const create = canvas.getByRole('button', { name: /create task/i });
    // Disabled with an empty title.
    await expect(create).toBeDisabled();

    await userEvent.type(
      canvas.getByLabelText('Title'),
      'Add a settings panel',
    );
    await userEvent.type(
      canvas.getByLabelText('Description'),
      'Build the settings surface.',
    );
    await expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        'Add a settings panel',
        'Build the settings surface.',
        'build',
        'main',
        { permissionMode: null, model: null, effort: null, maxTurns: null, maxBudgetUsd: null, branch: null, baseBranch: null, attachments: [] },
      ),
    );
  },
};

/** Play test: picking the Research kind threads it through onCreate. */
export const CreatesResearchTask: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Title'), 'Survey caching options');
    await userEvent.click(canvas.getByRole('radio', { name: /research/i }));
    await userEvent.click(canvas.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith('Survey caching options', '', 'research', 'main', {
        permissionMode: null,
        model: null,
        effort: null,
        maxTurns: null,
        maxBudgetUsd: null,
        branch: null,
        baseBranch: null,
        attachments: [],
      }),
    );
  },
};

/** Play test: choosing the Worktree run mode threads it through onCreate. */
export const CreatesWorktreeTask: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Title'), 'Isolate the risky refactor');
    await userEvent.click(canvas.getByRole('radio', { name: 'Worktree' }));
    await userEvent.click(canvas.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        'Isolate the risky refactor',
        '',
        'build',
        'worktree',
        { permissionMode: null, model: null, effort: null, maxTurns: null, maxBudgetUsd: null, branch: null, baseBranch: null, attachments: [] },
      ),
    );
  },
};

/** Play test: per-task permission / model / effort overrides thread
 *  through onCreate as the options object. */
export const CreatesWithOverrides: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Title'), 'Apply a migration');
    await userEvent.click(canvas.getByRole('radio', { name: /^plan$/i }));
    const models = within(canvas.getByRole('radiogroup', { name: /model/i }));
    await userEvent.click(models.getByRole('radio', { name: /sonnet/i }));
    const efforts = within(canvas.getByRole('radiogroup', { name: /reasoning effort/i }));
    await userEvent.click(efforts.getByRole('radio', { name: /^high$/i }));
    await userEvent.click(canvas.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith('Apply a migration', '', 'build', 'main', {
        permissionMode: 'plan',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        maxTurns: null,
        maxBudgetUsd: null,
        branch: null,
        baseBranch: null,
        attachments: [],
      }),
    );
  },
};

/** Play test: per-task autonomy ceilings (SDK guardrails) thread through
 *  onCreate as numeric options; a blank field stays `null` (inherit). */
export const CreatesWithLimits: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Title'), 'Bounded autonomous run');
    await userEvent.type(canvas.getByLabelText('Max turns'), '40');
    await userEvent.type(canvas.getByLabelText('Max budget (USD)'), '2.5');
    await userEvent.click(canvas.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith('Bounded autonomous run', '', 'build', 'main', {
        permissionMode: null,
        model: null,
        effort: null,
        maxTurns: 40,
        maxBudgetUsd: 2.5,
        branch: null,
        baseBranch: null,
        attachments: [],
      }),
    );
  },
};
