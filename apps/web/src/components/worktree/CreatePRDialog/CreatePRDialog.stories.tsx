import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import type { Task } from '@/lib/bridge';

import { portaledSurface } from '../../../../.storybook/test-utils';
import { makeTask } from '../../board/_fixtures';
import { CreatePRDialog } from './CreatePRDialog';

/** A verified, committed worktree task — the shape eligible for a PR. Outside
 *  Tauri the drafter returns the empty fallback, so the dialog pre-fills from
 *  this task's own title/description (the local degrade path). */
const TASK: Task = makeTask({
  id: 't-pr',
  status: 'done',
  title: 'Wire up auth guard',
  description: 'Adds the auth middleware and covers it with tests.',
  branch: 'nc/auth-guard',
  baseBranch: 'main',
  runMode: 'worktree',
  verified: true,
  committed: true,
});

const meta = {
  title: 'Worktree/CreatePRDialog',
  component: CreatePRDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    task: TASK,
    onCreate: fn(async () => {}),
    onClose: fn(),
  },
} satisfies Meta<typeof CreatePRDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Closed: Story = { args: { open: false } };

/** Play test: outside Tauri the drafter degrades to the task's own title and
 *  description, pre-filling both fields without blocking the dialog. */
export const PrefillsFromFallback: Story = {
  play: async () => {
    const canvas = portaledSurface();
    const title = canvas.getByLabelText('Title');
    await waitFor(() => expect(title).toHaveValue('Wire up auth guard'));
    await expect(canvas.getByLabelText('Body')).toHaveValue(
      'Adds the auth middleware and covers it with tests.',
    );
  },
};

/** Play test: the confirm footer states exactly what leaves the machine, and
 *  confirming relays the edited values (base + draft flag included). */
export const EditsAndCreates: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    const title = canvas.getByLabelText('Title');
    await waitFor(() => expect(title).toHaveValue('Wire up auth guard'));

    await expect(
      canvas.getByText(/open a\s+pull request against/i),
    ).toBeInTheDocument();

    await userEvent.clear(title);
    await userEvent.type(title, 'feat: wire up the auth guard');
    // The checkbox <input> is sr-only; click the visible label text instead.
    await userEvent.click(canvas.getByText('Open as a draft pull request'));
    await userEvent.click(canvas.getByRole('button', { name: 'Create PR' }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith('t-pr', {
        base: 'main',
        title: 'feat: wire up the auth guard',
        body: 'Adds the auth middleware and covers it with tests.',
        draft: true,
      }),
    );
    await waitFor(() => expect(args.onClose).toHaveBeenCalled());
  },
};

/** Play test: Cancel dismisses without creating. */
export const Cancels: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onClose).toHaveBeenCalled();
    await expect(args.onCreate).not.toHaveBeenCalled();
  },
};
