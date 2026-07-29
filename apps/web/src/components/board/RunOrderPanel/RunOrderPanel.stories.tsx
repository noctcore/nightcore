import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { RunOrderProjection, Task } from '@/lib/bridge';

import { makeTask } from '../_fixtures';
import { EMPTY_RUN_ORDER, RunOrderProvider } from '../run-order';
import { RunOrderPanel } from './RunOrderPanel';
import type { RunOrderPanelProps } from './RunOrderPanel.types';

/** A chained board: `two` waits on `one`, `three` on `two`, plus a task whose dependency
 *  failed (so it can never become eligible). */
const BOARD: Task[] = [
  makeTask({ id: 'one', title: 'Extract the settings store', createdAt: 10 }),
  makeTask({ id: 'two', title: 'Add the rate limiter', createdAt: 20, dependencies: ['one'] }),
  makeTask({ id: 'three', title: 'Wire up auth guard', createdAt: 30, dependencies: ['two'] }),
  makeTask({ id: 'dead', title: 'Trim the shiki bundle', createdAt: 40, dependencies: ['gone'] }),
];

/** The projection the Rust `run_order` command returns for `BOARD` at 2 free slots: the
 *  chain lands in successive waves and `dead` is never eligible. */
const CHAINED: RunOrderProjection = {
  entries: [
    { taskId: 'one', position: 1, wave: 0, startsNow: true, blockedBy: [] },
    { taskId: 'two', position: 2, wave: 1, startsNow: false, blockedBy: ['one'] },
    { taskId: 'three', position: 3, wave: 2, startsNow: false, blockedBy: ['two'] },
  ],
  unreachable: ['dead'],
  freeSlots: 2,
  maxConcurrency: 3,
  startsNowCount: 1,
};

function RunOrderPanelFixture({
  projection = CHAINED,
  ...props
}: RunOrderPanelProps & { projection?: RunOrderProjection }) {
  return (
    <RunOrderProvider value={projection}>
      <RunOrderPanel {...props} />
    </RunOrderProvider>
  );
}

const meta = {
  title: 'Board/RunOrderPanel',
  component: RunOrderPanelFixture,
  args: { open: true, tasks: BOARD, onClose: fn(), onSelectTask: fn() },
} satisfies Meta<typeof RunOrderPanelFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A hand-authored chain: position 1 starts now, the rest wait a pass each, and the
 *  failed-dependency task is grouped as never eligible. */
export const ChainedBoard: Story = {};

/** Nothing queued — the sheet says so instead of rendering an empty list. */
export const NothingQueued: Story = {
  args: { projection: { ...EMPTY_RUN_ORDER, freeSlots: 3, maxConcurrency: 3 } },
};

/** Every slot busy: the whole queue is legible, but nothing starts now. */
export const AllSlotsBusy: Story = {
  args: {
    projection: {
      ...CHAINED,
      entries: CHAINED.entries.map((e) => ({ ...e, wave: e.wave + 1, startsNow: false })),
      freeSlots: 0,
      startsNowCount: 0,
    },
  },
};

/** Play test: a row click opens that task's drawer. */
export const RowOpensTheTask: Story = {
  play: async ({ args }) => {
    // The sheet renders in a portal (`Modal` → `createPortal(document.body)`), so query
    // the document body rather than the story canvas.
    const body = within(document.body);
    await userEvent.click(
      body.getByRole('button', { name: 'Open Extract the settings store — run order position 1' }),
    );
    await expect(args.onSelectTask).toHaveBeenCalledWith('one');
  },
};
