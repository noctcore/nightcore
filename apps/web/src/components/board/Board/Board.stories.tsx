import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';
import { Board } from './Board';
import { BLOCKED_TASK, TASKS_BY_STATUS } from '../_fixtures';

const meta = {
  title: 'Board/Board',
  component: Board,
  parameters: { layout: 'fullscreen' },
  args: {
    projectPath: '~/dev/nightcore',
    projectBranch: 'main',
    concurrency: 3,
    autoMode: false,
    breaker: null,
    selectedId: null,
    logCounts: { 't-running': 7 },
    onSelect: fn(),
    onNewTask: fn(),
    onRun: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onClearColumn: fn(),
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

const ALL_TASKS = [
  TASKS_BY_STATUS.backlog,
  TASKS_BY_STATUS.ready,
  BLOCKED_TASK,
  TASKS_BY_STATUS.in_progress,
  TASKS_BY_STATUS.waiting_approval,
  TASKS_BY_STATUS.done,
  TASKS_BY_STATUS.failed,
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
