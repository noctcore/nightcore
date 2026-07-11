import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';

import type { Task, WorktreeInfo } from '@/lib/bridge';
import {
  type ActiveWorktree,
  type RemovableWorktreeTab,
  WorktreesProvider,
} from '@/lib/worktrees-context';

import { BLOCKED_TASK, makeTaskActions, TASKS_BY_STATUS, WORKTREES } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { BoardChromeProvider, type BoardChromeValue } from '../chrome';
import { Board } from './Board';
import type { BoardProps } from './Board.types';

/** One stable no-op action group for every board story — the cards inside read
 *  their handlers from `TaskActionsContext` now, not Board props. */
const STORY_ACTIONS = makeTaskActions();

/** The board-chrome cluster (appearance + auto-loop) the board + its BoardHeader
 *  consume from `BoardChromeContext` — surfaced as story ARGS so plays and tests
 *  keep overriding individual fields (`autoMode`, `breaker`, the handlers) per
 *  render, exactly as they did when these were Board props. */
type ChromeArgs = Partial<BoardChromeValue>;

/** The story fixture: the board wrapped in the three providers it now requires —
 *  task actions for the cards, the board-chrome cluster for the header/banner, and
 *  the worktrees slice for the switcher + the board's worktree filter. The chrome +
 *  worktree clusters stay story ARGS so plays and tests keep overriding them. */
function BoardFixture({
  worktrees,
  activeWorktree,
  onSelectWorktree,
  onRemoveWorktree,
  onRefreshWorktrees,
  appearanceOverride = null,
  backgroundVersion = null,
  onChangeAppearance,
  onPickBackground,
  onClearBackground,
  concurrency = 3,
  autoMode = false,
  autoCommitOnVerified = false,
  autoPauseUsageThreshold = 90,
  usageMeterEnabled = true,
  usagePause = null,
  breaker = null,
  onToggleAutoMode,
  onAutoCommitChange,
  onThresholdChange,
  onConcurrencyChange,
  onResume,
  ...props
}: BoardProps & {
  worktrees: WorktreeInfo[];
  activeWorktree: ActiveWorktree;
  onSelectWorktree?: (active: ActiveWorktree) => void;
  onRemoveWorktree?: (tab: RemovableWorktreeTab) => void;
  onRefreshWorktrees?: () => void;
} & ChromeArgs) {
  return (
    <TaskActionsProvider actions={STORY_ACTIONS}>
      <BoardChromeProvider
        value={{
          appearanceOverride,
          backgroundVersion,
          onChangeAppearance: onChangeAppearance ?? (() => {}),
          onPickBackground: onPickBackground ?? (() => {}),
          onClearBackground: onClearBackground ?? (() => {}),
          concurrency,
          autoMode,
          autoCommitOnVerified,
          autoPauseUsageThreshold,
          usageMeterEnabled,
          usagePause,
          breaker,
          onToggleAutoMode: onToggleAutoMode ?? (() => {}),
          onAutoCommitChange: onAutoCommitChange ?? (() => {}),
          onThresholdChange: onThresholdChange ?? (() => {}),
          onConcurrencyChange: onConcurrencyChange ?? (() => {}),
          onResume: onResume ?? (() => {}),
        }}
      >
        <WorktreesProvider
          value={{
            worktrees,
            activeWorktree,
            setActiveWorktree: onSelectWorktree ?? (() => {}),
            removeWorktree: onRemoveWorktree ?? (() => {}),
            refreshWorktrees: onRefreshWorktrees ?? (() => {}),
          }}
        >
          <Board {...props} />
        </WorktreesProvider>
      </BoardChromeProvider>
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/Board',
  component: BoardFixture,
  parameters: { layout: 'fullscreen' },
  args: {
    projectId: 'proj-1',
    projectName: 'nightcore',
    projectPath: '~/dev/nightcore',
    projectBranch: 'main',
    appearanceOverride: null,
    backgroundVersion: null,
    onChangeAppearance: fn(),
    onPickBackground: fn(),
    onClearBackground: fn(),
    worktrees: [],
    activeWorktree: null,
    onSelectWorktree: fn(),
    onRemoveWorktree: fn(),
    onRefreshWorktrees: fn(),
    concurrency: 3,
    autoMode: false,
    autoCommitOnVerified: false,
    autoPauseUsageThreshold: 90,
    usageMeterEnabled: true,
    usagePause: null,
    breaker: null,
    selectedId: null,
    logCounts: { 't-running': 7 },
    blockedIds: new Set<string>(),
    promptIds: new Set<string>(),
    onNewTask: fn(),
    onMoveTask: fn(),
    onClearColumn: fn(),
    onToggleAutoMode: fn(),
    onAutoCommitChange: fn(),
    onThresholdChange: fn(),
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
} satisfies Meta<typeof BoardFixture>;

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

/** Usage-paused (spec 2026-07-11): the loop stopped picking up new runs because a
 *  Claude window crossed the threshold — a dismissable banner shows the window +
 *  reset clock. No Resume button (it auto-resumes when usage cools). */
export const UsagePaused: Story = {
  args: {
    tasks: ALL_TASKS,
    autoMode: true,
    usagePause: {
      provider: 'claude',
      windowLabel: 'Session (5h)',
      usedPercent: 94,
      resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    },
  },
};

/** A usage window over threshold with no reset instant — the banner drops the
 *  "resumes ~…" clause. */
export const UsagePausedNoReset: Story = {
  args: {
    tasks: ALL_TASKS,
    autoMode: true,
    usagePause: {
      provider: 'claude',
      windowLabel: 'Weekly',
      usedPercent: 97,
      resetsAt: null,
    },
  },
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
    await userEvent.click(canvas.getByRole('button', { name: 'Auto Mode' }));
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
