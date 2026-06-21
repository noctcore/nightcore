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
    onChangeMaxTurns: fn(),
    onChangeMaxBudget: fn(),
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
      streamedPartial: true,
      entries: [
        {
          kind: 'text',
          markdown:
            '## Generating the client\n\nReading `vite.config.ts`, then writing the typed client from the OpenAPI spec.\n\n- Parsed the schema\n- Emitted `api/client.ts`',
        },
        { kind: 'tool', id: 1, toolName: 'Read', input: { file_path: 'apps/web/vite.config.ts' } },
        { kind: 'tool', id: 2, toolName: 'Grep', input: { pattern: 'createClient', path: 'src' } },
        { kind: 'tool', id: 3, toolName: 'Bash', input: { command: 'bun run codegen:api' } },
        { kind: 'tool', id: 4, toolName: 'Edit', input: { file_path: 'src/api/client.ts' } },
      ],
      toolSeq: 4,
      costUsd: 0.18,
    },
  },
};

/** Interleaved timeline: text → tool → text → tool → trailing text. Proves the
 *  two speaking turns split by a tool call render as visually separated markdown
 *  blocks, with tool steps boxed inline between them. */
export const InterleavedTimeline: Story = {
  args: {
    task: TASKS_BY_STATUS.in_progress,
    anyRunning: true,
    stream: {
      ...EMPTY_STREAM,
      streamedPartial: true,
      entries: [
        {
          kind: 'text',
          markdown:
            "First I'll find where the client is wired so the new types land in the right module.",
        },
        { kind: 'tool', id: 1, toolName: 'Grep', input: { pattern: 'createClient', path: 'src' } },
        {
          kind: 'text',
          markdown:
            'Found it in `src/api/index.ts`. Now generating the typed client from the OpenAPI spec.',
        },
        { kind: 'tool', id: 2, toolName: 'Bash', input: { command: 'bun run codegen:api' } },
        {
          kind: 'text',
          markdown: 'Codegen succeeded — `src/api/client.ts` now exports the typed client.',
        },
      ],
      toolSeq: 2,
      costUsd: 0.12,
    },
  },
};

/** A fresh backlog task: the Session card opens by default (editable) so the
 *  per-task pickers surface without a click. */
export const SessionCardExpanded: Story = {
  args: { task: TASKS_BY_STATUS.backlog, stream: undefined },
};

/** A verified (read-only) task: the Session card starts collapsed to its middot
 *  summary line, demoting config below the content. */
export const SessionCardCollapsed: Story = {
  args: {
    task: makeTask({
      id: 't-session-collapsed',
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
    gauntlet: GAUNTLET_PASSED,
    stream: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Collapsed by default for a read-only task; clicking the summary expands it.
    const toggle = canvas.getByRole('button', { name: /worktree/i });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
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

    // Committing a max-turns ceiling (blur) patches the per-task guardrail.
    const turns = canvas.getByRole('spinbutton', { name: 'Max turns' });
    await userEvent.type(turns, '40');
    await userEvent.tab();
    await expect(args.onChangeMaxTurns).toHaveBeenCalledWith('t-edit', 40);
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

/** A research task that finished done but was never reviewed — shows neutral
 *  "DONE" badge (not green "Verified"), because `verified` is false. */
export const ResearchDone: Story = {
  args: {
    task: makeTask({
      id: 't-research',
      status: 'done',
      kind: 'research',
      runMode: 'main',
      branch: null,
      verified: false,
      committed: true,
      costUsd: 1.63,
      summary: 'Investigated the Rust auto-update system. No code changes were made.',
    }),
    gauntlet: null,
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
      streamedPartial: true,
      entries: [
        { kind: 'text', markdown: 'Running git diff against the base branch…' },
        { kind: 'tool', id: 1, toolName: 'Bash' },
      ],
      toolSeq: 1,
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
