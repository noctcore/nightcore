import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { RunOrderProjection, Task } from '@/lib/bridge';

import { makeTask, makeTaskActions } from '../_fixtures';
import { TaskActionsProvider, type TaskDetailActions } from '../actions';
import { EMPTY_RUN_ORDER, RunOrderProvider } from '../run-order';
import { TaskSelectionProvider } from '../selection';
import { BulkActionBar } from './BulkActionBar';
import type { BulkActionBarProps } from './BulkActionBar.types';

/** A three-task backlog in launch order (createdAt 10/20/30) — the chain fixture. */
export const CHAIN_BOARD: Task[] = [
  makeTask({ id: 'one', title: 'Extract the settings store', createdAt: 10 }),
  makeTask({ id: 'two', title: 'Add the rate limiter', createdAt: 20 }),
  makeTask({ id: 'three', title: 'Wire up auth guard', createdAt: 30 }),
];

/** Three free slots, nothing queued — enough capacity for a bulk Run. */
const THREE_FREE: RunOrderProjection = {
  ...EMPTY_RUN_ORDER,
  freeSlots: 3,
  maxConcurrency: 3,
};

/** The story fixture: the bar wrapped in the three contexts it reads (selection, actions,
 *  run order). Selection is inert-but-populated so the bar renders its verbs. */
function BulkActionBarFixture({
  selectedIds,
  runOrder = THREE_FREE,
  onRun,
  onChangeDependencies,
  onBulkDelete,
  ...props
}: BulkActionBarProps & {
  selectedIds: string[];
  runOrder?: RunOrderProjection;
} & Pick<Partial<TaskDetailActions>, 'onRun' | 'onChangeDependencies' | 'onBulkDelete'>) {
  return (
    <TaskActionsProvider
      actions={makeTaskActions({ onRun, onChangeDependencies, onBulkDelete })}
    >
      <RunOrderProvider value={runOrder}>
        <TaskSelectionProvider
          value={{
            selectedIds: new Set(selectedIds),
            toggle: () => {},
            clear: () => {},
            select: () => {},
          }}
        >
          <BulkActionBar {...props} />
        </TaskSelectionProvider>
      </RunOrderProvider>
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/BulkActionBar',
  component: BulkActionBarFixture,
  args: {
    tasks: CHAIN_BOARD,
    onMoveTask: fn(),
    onRun: fn(),
    onChangeDependencies: fn(),
    onBulkDelete: fn(),
  },
} satisfies Meta<typeof BulkActionBarFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing selected — the bar renders nothing, so an untouched board is unchanged. */
export const Hidden: Story = { args: { selectedIds: [] } };

/** One task selected: Chain is refused (it needs two) with the reason on its tooltip. */
export const OneSelected: Story = { args: { selectedIds: ['two'] } };

/** Three selected, unchained — every verb is live. */
export const ThreeSelected: Story = { args: { selectedIds: ['one', 'two', 'three'] } };

/** Already chained: Chain is inert ("already chained in this order") and Unchain is live. */
export const AlreadyChained: Story = {
  args: {
    selectedIds: ['one', 'two', 'three'],
    tasks: [
      CHAIN_BOARD[0]!,
      makeTask({ id: 'two', title: 'Add the rate limiter', createdAt: 20, dependencies: ['one'] }),
      makeTask({ id: 'three', title: 'Wire up auth guard', createdAt: 30, dependencies: ['two'] }),
    ],
  },
};

/** Every slot busy — Run is refused with the honest slot reason instead of firing three
 *  runs the backend would reject one by one. */
export const NoFreeSlots: Story = {
  args: {
    selectedIds: ['one', 'two', 'three'],
    runOrder: { ...EMPTY_RUN_ORDER, freeSlots: 0, maxConcurrency: 3 },
  },
};

/** Play test: Chain commits ONE dependency edit per link, in launch order. */
export const ChainsTheSelection: Story = {
  args: { selectedIds: ['one', 'two', 'three'] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^chain$/i }));
    await expect(args.onChangeDependencies).toHaveBeenCalledWith('two', ['one']);
    await expect(args.onChangeDependencies).toHaveBeenCalledWith('three', ['two']);
  },
};

/** Play test: Delete routes the whole selection through the single bulk confirmation. */
export const DeletesTheSelection: Story = {
  args: { selectedIds: ['one', 'three'] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^delete$/i }));
    await expect(args.onBulkDelete).toHaveBeenCalledWith(['one', 'three']);
  },
};

/** Play test: "Move to Backlog" fans the manual status move across the selection. */
export const MovesTheSelection: Story = {
  args: { selectedIds: ['one', 'two'] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /move to…/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: /move to done/i }));
    await expect(args.onMoveTask).toHaveBeenCalledWith('one', 'done');
    await expect(args.onMoveTask).toHaveBeenCalledWith('two', 'done');
  },
};
