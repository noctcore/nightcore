import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';
import { Board } from './Board';
import { BLOCKED_TASK, TASKS_BY_STATUS, WORKTREES } from '../_fixtures';
import type { Task } from '@/lib/bridge';

const meta = {
  title: 'Board/Board',
  component: Board,
  parameters: { layout: 'fullscreen' },
  args: {
    projectName: 'nightcore',
    projectPath: '~/dev/nightcore',
    projectBranch: 'main',
    worktrees: [],
    activeWorktree: null,
    onSelectWorktree: fn(),
    concurrency: 3,
    autoMode: false,
    breaker: null,
    selectedId: null,
    logCounts: { 't-running': 7 },
    blockedIds: new Set<string>(),
    promptIds: new Set<string>(),
    onSelect: fn(),
    onNewTask: fn(),
    onRun: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onMoveTask: fn(),
    onClearColumn: fn(),
    onApprove: fn(),
    onRefine: fn(),
    onCommit: fn(),
    onMerge: fn(),
    onToggleAutoMode: fn(),
    onConcurrencyChange: fn(),
    onResume: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '80vh', width: '100%' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Re-tag a task as main-mode (no worktree branch) so it lives under the Main
 *  tab — the default board view in these stories. */
const asMain = (task: Task): Task => ({ ...task, runMode: 'main', branch: null });

const ALL_TASKS = [
  TASKS_BY_STATUS.backlog,
  TASKS_BY_STATUS.ready,
  BLOCKED_TASK,
  TASKS_BY_STATUS.in_progress,
  TASKS_BY_STATUS.waiting_approval,
  TASKS_BY_STATUS.done,
  TASKS_BY_STATUS.failed,
].map(asMain);

/** The original worktree-mode fixtures, for the switcher stories below. */
const WORKTREE_TASKS = [
  TASKS_BY_STATUS.in_progress,
  TASKS_BY_STATUS.done,
];

export const Empty: Story = {
  args: {
    tasks: [TASKS_BY_STATUS.backlog],
  },
};

export const Populated: Story = {
  args: {
    tasks: ALL_TASKS,
    selectedId: 't-running',
  },
};

/** Auto Mode reflects the live loop state: the toggle reads as on. */
export const AutoModeOn: Story = {
  args: { tasks: ALL_TASKS, autoMode: true },
};

/** The circuit breaker tripped: a dismissable Resume banner is surfaced. */
export const CircuitBreakerPaused: Story = {
  args: { tasks: ALL_TASKS, breaker: { failureThreshold: 3 } },
};

/** Play test: typing a keyword filters cards to title/description matches. */
export const SearchFilters: Story = {
  args: { tasks: ALL_TASKS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Generate API client')).toBeInTheDocument();
    await userEvent.type(
      canvas.getByPlaceholderText('Search tasks by keyword…'),
      'auth guard',
    );
    await expect(canvas.queryByText('Generate API client')).not.toBeInTheDocument();
    await expect(canvas.getByText('Wire up auth guard')).toBeInTheDocument();
  },
};

/** Play test: clicking Auto Mode drives the loop toggle handler. */
export const TogglesAutoMode: Story = {
  args: { tasks: ALL_TASKS },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /auto mode/i }));
    await expect(args.onToggleAutoMode).toHaveBeenCalled();
  },
};

/** Play test: moving the slider drives the concurrency handler. */
export const ChangesConcurrency: Story = {
  args: { tasks: ALL_TASKS },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole('slider', { name: /max concurrency/i });
    fireEvent.change(slider, { target: { value: '5' } });
    await expect(args.onConcurrencyChange).toHaveBeenCalledWith(5);
  },
};

/** Play test: the circuit-breaker banner's Resume button drives the handler. */
export const ResumesFromBreaker: Story = {
  args: { tasks: ALL_TASKS, breaker: { failureThreshold: 3 } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/paused after 3 consecutive failures/i),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /resume/i }));
    await expect(args.onResume).toHaveBeenCalled();
  },
};

/** The backend-computed blocked set drives the chip + locked Run: the blocked
 *  backlog card shows a disabled "Blocked" action. */
export const BlockedFromBackend: Story = {
  args: { tasks: ALL_TASKS, blockedIds: new Set([BLOCKED_TASK.id]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const blockedBtn = canvas.getByRole('button', { name: /^blocked$/i });
    await expect(blockedBtn).toBeDisabled();
  },
};

/** Play test: the board wires @dnd-kit drag-and-drop. Eligible cards carry the
 *  grab handle, the Backlog column advertises itself as a drop target, and the
 *  running card (which owns a live run) is pinned. A full pointer drag is flaky in
 *  the browser runner, so the cross-column move itself is covered by BoardDnd's
 *  `resolveDrop` unit tests. */
export const CardsAreDraggable: Story = {
  args: { tasks: ALL_TASKS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Wire up auth guard');
    await expect(canvasElement.querySelectorAll('.cursor-grab').length).toBeGreaterThan(0);

    const backlogHeading = canvas.getByRole('heading', { name: 'Backlog', level: 2 });
    await expect(backlogHeading.closest('[aria-dropeffect="move"]')).not.toBeNull();

    // The In Progress card is pinned — its card root never gets the grab handle.
    const running = canvas.getByText('Generate API client');
    await expect(running.closest('.cursor-grab')).toBeNull();
  },
};

/** The worktree switcher surfaces a Main tab plus a tab per live worktree above
 *  the board. With worktree-mode tasks present, the bar appears. */
export const WithWorktreeSwitcher: Story = {
  args: {
    tasks: [...ALL_TASKS, ...WORKTREE_TASKS],
    worktrees: WORKTREES,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tab', { name: /^main/i })).toBeInTheDocument();
    await expect(canvas.getByRole('tab', { name: /nc\/api-client/i })).toBeInTheDocument();
  },
};

/** Selecting a worktree tab filters the board to that branch's tasks: the
 *  Main-only 'Add dark-mode toggle' card disappears, the worktree card stays. */
export const FiltersToWorktree: Story = {
  args: {
    tasks: [...ALL_TASKS, ...WORKTREE_TASKS],
    worktrees: WORKTREES,
    activeWorktree: 'nc/api-client',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Generate API client')).toBeInTheDocument();
    await expect(canvas.queryByText('Add dark-mode toggle')).not.toBeInTheDocument();
  },
};

/** Play test: clicking a worktree tab reports the branch selection upward. */
export const SelectsWorktreeTab: Story = {
  args: {
    tasks: [...ALL_TASKS, ...WORKTREE_TASKS],
    worktrees: WORKTREES,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /nc\/api-client/i }));
    await expect(args.onSelectWorktree).toHaveBeenCalledWith('nc/api-client');
  },
};
