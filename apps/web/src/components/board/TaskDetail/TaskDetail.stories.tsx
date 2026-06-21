import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { TaskDetail } from './TaskDetail';
import { EMPTY_STREAM } from '../session-stream';
import {
  GAUNTLET_FAILED,
  GAUNTLET_PASSED,
  SAMPLE_REVIEW_CHANGES,
  SAMPLE_REVIEW_PASS,
  TASKS_BY_STATUS,
  makeTask,
} from '../_fixtures';

const meta = {
  title: 'Board/TaskDetail',
  component: TaskDetail,
  parameters: { layout: 'fullscreen' },
  args: {
    anyRunning: false,
    gauntlet: null,
    gauntletRunning: false,
    onClose: fn(),
    onRun: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onRespondPermission: fn(),
    onApprove: fn(),
    onReject: fn(),
    onRefine: fn(),
    onChangeKind: fn(),
    onChangeRunMode: fn(),
    onChangePermissionMode: fn(),
    onChangeModel: fn(),
    onChangeEffort: fn(),
    onAcceptReview: fn(),
    onRejectReview: fn(),
    onRerunVerification: fn(),
    onRunGauntlet: fn(),
    onMerge: fn(),
    onCommit: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'flex-end', height: '80vh' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyBacklog: Story = {
  args: { task: TASKS_BY_STATUS.backlog, stream: undefined },
};

export const Running: Story = {
  args: {
    task: TASKS_BY_STATUS.in_progress,
    anyRunning: true,
    stream: {
      ...EMPTY_STREAM,
      answer:
        '## Generating the client\n\nReading `vite.config.ts`, then writing the typed client from the OpenAPI spec.\n\n- Parsed the schema\n- Emitted `api/client.ts`',
      tools: [
        { id: 1, toolName: 'Read', input: { file_path: 'apps/web/vite.config.ts' } },
        { id: 2, toolName: 'Grep', input: { pattern: 'createClient', path: 'src' } },
        { id: 3, toolName: 'Bash', input: { command: 'bun run codegen:api' } },
        { id: 4, toolName: 'Edit', input: { file_path: 'src/api/client.ts' } },
      ],
      costUsd: 0.18,
    },
  },
};

/** A not-yet-run task showing the editable per-task pickers (M4.7 §F): kind,
 *  run mode, permission mode, and model + effort. */
export const EditablePickers: Story = {
  args: {
    task: makeTask({
      id: 't-edit',
      status: 'backlog',
      title: 'Apply a destructive migration',
      permissionMode: 'plan',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    }),
    stream: undefined,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const modes = within(canvas.getByRole('radiogroup', { name: /permission mode/i }));
    await userEvent.click(modes.getByRole('radio', { name: /^ask$/i }));
    await expect(args.onChangePermissionMode).toHaveBeenCalledWith('t-edit', 'ask');
  },
};

/** A verified, committed task with a passing gauntlet — Merge is enabled. */
export const Done: Story = {
  args: {
    task: makeTask({
      id: 't-done',
      status: 'done',
      title: 'Wire up auth guard',
      summary: 'Added the auth middleware and covered it with tests.',
      costUsd: 0.42,
      branch: 'nc/auth-guard',
      runMode: 'worktree',
      verified: true,
      committed: true,
      review: SAMPLE_REVIEW_PASS,
    }),
    gauntlet: GAUNTLET_PASSED,
    stream: undefined,
  },
};

/** A verified task before the gauntlet has run — Merge stays disabled. */
export const VerifiedMergeGated: Story = {
  args: {
    task: makeTask({
      id: 't-done',
      status: 'done',
      title: 'Wire up auth guard',
      branch: 'nc/auth-guard',
      runMode: 'worktree',
      verified: true,
      committed: true,
      review: SAMPLE_REVIEW_PASS,
    }),
    gauntlet: null,
    stream: undefined,
  },
};

/** A main-mode verified task — it edits the project tree in place, so Merge is
 *  replaced by a disabled "Committed" state (`merge_task` refuses main mode). */
export const MainModeCommitted: Story = {
  args: {
    task: makeTask({
      id: 't-main',
      status: 'done',
      title: 'Tidy the README',
      runMode: 'main',
      branch: null,
      verified: true,
      committed: true,
      review: SAMPLE_REVIEW_PASS,
    }),
    gauntlet: GAUNTLET_PASSED,
    stream: undefined,
  },
};

/** A plan-mode run paused at `ExitPlanMode`: the plan + Approve/Refine/Reject. */
export const WaitingApproval: Story = {
  args: {
    task: makeTask({
      id: 't-waiting',
      status: 'waiting_approval',
      title: 'Apply destructive migration',
      plan: '1. Back up the users table\n2. Add the new column\n3. Backfill from email',
      branch: 'nc/destructive-migration',
    }),
    stream: undefined,
  },
};

/** A reviewer session reading the diff — the verifying phase. */
export const Verifying: Story = {
  args: {
    task: TASKS_BY_STATUS.verifying,
    anyRunning: true,
    stream: {
      ...EMPTY_STREAM,
      answer: 'Running git diff against the base branch…',
      tools: [{ id: 1, toolName: 'Bash' }],
    },
  },
};

/** A verification parked for approval (budget exhausted): the verdict + Accept /
 *  Rerun / Reject controls. */
export const ReviewParked: Story = {
  args: {
    task: makeTask({
      id: 't-waiting',
      status: 'waiting_approval',
      title: 'Apply destructive migration',
      branch: 'nc/destructive-migration',
      review: SAMPLE_REVIEW_CHANGES,
      fixAttempts: 2,
    }),
    stream: undefined,
  },
};

/** The verified column with a failed gauntlet — Merge stays disabled. */
export const GauntletFailed: Story = {
  args: {
    task: makeTask({
      id: 't-done',
      status: 'done',
      title: 'Wire up auth guard',
      branch: 'nc/auth-guard',
      runMode: 'worktree',
      verified: true,
      committed: true,
      review: SAMPLE_REVIEW_PASS,
    }),
    gauntlet: GAUNTLET_FAILED,
    stream: undefined,
  },
};

/** A running task with a parked permission prompt rendered in the panel. */
export const RunningWithPrompt: Story = {
  args: {
    task: TASKS_BY_STATUS.in_progress,
    anyRunning: true,
    stream: undefined,
    prompts: [
      {
        taskId: 't-running',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'rm -rf dist && bun run build' },
      },
    ],
  },
};

export const Failed: Story = {
  args: { task: TASKS_BY_STATUS.failed, stream: undefined },
};

/** Play test: Accept on a review-parked task relays the verification override. */
export const AcceptsReview: Story = {
  args: { ...ReviewParked.args },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /accept/i }));
    await expect(args.onAcceptReview).toHaveBeenCalledWith('t-waiting');
  },
};

/** Play test: "Run checks" on a verified task triggers the gauntlet. */
export const RunsGauntlet: Story = {
  args: { ...VerifiedMergeGated.args },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /run checks/i }));
    await expect(args.onRunGauntlet).toHaveBeenCalledWith('t-done');
  },
};
