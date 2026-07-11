import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';

import type { BoardAppearance } from '@/lib/bridge';
import { WorktreesProvider } from '@/lib/worktrees-context';

import { DEFAULT_APPEARANCE } from '../appearance';
import { BoardChromeProvider, type BoardChromeValue } from '../chrome';
import { BoardHeader } from './BoardHeader';
import type { BoardHeaderProps } from './BoardHeader.types';

/** The chrome-cluster slice the header consumes — surfaced as story ARGS so
 *  plays and tests keep overriding individual handlers per render. */
type ChromeArgs = Partial<
  Pick<
    BoardChromeValue,
    | 'concurrency'
    | 'autoMode'
    | 'autoCommitOnVerified'
    | 'autoPauseUsageThreshold'
    | 'usageMeterEnabled'
    | 'onToggleAutoMode'
    | 'onAutoCommitChange'
    | 'onThresholdChange'
    | 'onConcurrencyChange'
    | 'onChangeAppearance'
    | 'onPickBackground'
    | 'onClearBackground'
  >
> & { onRefreshWorktrees?: () => void };

/** The story fixture: the header wrapped in the `BoardChromeProvider` (the
 *  appearance + auto-loop cluster) and `WorktreesProvider` (Refresh) it now
 *  reads from. */
function BoardHeaderFixture({
  concurrency = 3,
  autoMode = false,
  autoCommitOnVerified = false,
  autoPauseUsageThreshold = 90,
  usageMeterEnabled = true,
  onToggleAutoMode,
  onAutoCommitChange,
  onThresholdChange,
  onConcurrencyChange,
  onChangeAppearance,
  onPickBackground,
  onClearBackground,
  onRefreshWorktrees,
  ...props
}: BoardHeaderProps & ChromeArgs) {
  return (
    <BoardChromeProvider
      value={{
        appearanceOverride: null,
        backgroundVersion: null,
        onChangeAppearance: onChangeAppearance ?? (() => {}),
        onPickBackground: onPickBackground ?? (() => {}),
        onClearBackground: onClearBackground ?? (() => {}),
        concurrency,
        autoMode,
        autoCommitOnVerified,
        autoPauseUsageThreshold,
        usageMeterEnabled,
        usagePause: null,
        breaker: null,
        onToggleAutoMode: onToggleAutoMode ?? (() => {}),
        onAutoCommitChange: onAutoCommitChange ?? (() => {}),
        onThresholdChange: onThresholdChange ?? (() => {}),
        onConcurrencyChange: onConcurrencyChange ?? (() => {}),
        onResume: () => {},
      }}
    >
      <WorktreesProvider
        value={{
          worktrees: [],
          activeWorktree: null,
          setActiveWorktree: () => {},
          removeWorktree: () => {},
          refreshWorktrees: onRefreshWorktrees ?? (() => {}),
        }}
      >
        <BoardHeader {...props} />
      </WorktreesProvider>
    </BoardChromeProvider>
  );
}

const APPEARANCE: BoardAppearance = DEFAULT_APPEARANCE;

const meta = {
  title: 'Board/BoardHeader',
  component: BoardHeaderFixture,
  parameters: { layout: 'fullscreen' },
  args: {
    taskCount: 7,
    projectName: 'nightcore',
    projectPath: '~/dev/nightcore',
    projectBranch: 'main',
    search: '',
    onSearchChange: fn(),
    onNewTask: fn(),
    appearance: APPEARANCE,
    backgroundUrl: null,
    onToggleAutoMode: fn(),
    onAutoCommitChange: fn(),
    onThresholdChange: fn(),
    onConcurrencyChange: fn(),
    onChangeAppearance: fn(),
    onPickBackground: fn(),
    onClearBackground: fn(),
    onRefreshWorktrees: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: '100%' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BoardHeaderFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Auto Mode reflects the live loop state: the toggle reads as on. */
export const AutoModeOn: Story = { args: { autoMode: true } };

/** Play test: clicking Auto Mode drives the loop toggle handler. */
export const TogglesAutoMode: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Auto Mode' }));
    await expect(args.onToggleAutoMode).toHaveBeenCalled();
  },
};

/** Play test: moving the slider drives the concurrency handler. */
export const ChangesConcurrency: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole('slider', { name: /max concurrency/i });
    fireEvent.change(slider, { target: { value: '5' } });
    await expect(args.onConcurrencyChange).toHaveBeenCalledWith(5);
  },
};

/** Play test: the header Refresh relays the shared worktrees refresh. */
export const RefreshesWorktrees: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: /refresh board & worktrees/i }),
    );
    await expect(args.onRefreshWorktrees).toHaveBeenCalled();
  },
};

/** Play test: typing in the search input relays the controlled query upward. */
export const SearchRelaysChanges: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: /search tasks/i }), 'a');
    await expect(args.onSearchChange).toHaveBeenCalledWith('a');
  },
};
