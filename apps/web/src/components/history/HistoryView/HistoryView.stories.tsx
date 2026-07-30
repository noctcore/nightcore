import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { HistoryList } from './HistoryView.parts';
import type { ScanRunSummary } from './HistoryView.types';

/** Build a summary fixture with sane defaults. */
function run(over: Partial<ScanRunSummary> & Pick<ScanRunSummary, 'id' | 'family'>): ScanRunSummary {
  return {
    title: '3 findings',
    status: 'completed',
    createdAt: Date.now() - 60_000,
    projectPath: '/repo',
    model: 'claude-opus-4-8',
    costUsd: 0.42,
    durationMs: 74_000,
    ...over,
  };
}

const MIXED: ScanRunSummary[] = [
  run({ id: 'i1', family: 'insight', title: '7 findings', createdAt: Date.now() - 30_000 }),
  run({
    id: 's1',
    family: 'scorecard',
    title: '5 dimensions graded',
    status: 'running',
    createdAt: Date.now() - 5 * 60_000,
  }),
  run({
    id: 'h1',
    family: 'harness',
    title: '12 conventions',
    status: 'failed',
    createdAt: Date.now() - 3 * 60 * 60_000,
  }),
  run({
    id: 'i2',
    family: 'insight',
    title: '1 finding',
    createdAt: Date.now() - 2 * 24 * 60 * 60_000,
  }),
];

const meta = {
  title: 'History/HistoryView',
  component: HistoryList,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: 420 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    runs: MIXED,
    loading: false,
    error: null,
    onOpenRun: fn(),
    onDeleteRun: fn(),
    retention: 50,
  },
} satisfies Meta<typeof HistoryList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A populated list — mixed families and statuses, newest first. */
export const Populated: Story = {};

/** No runs yet — the empty state with its call to action. */
export const Empty: Story = { args: { runs: [] } };

/** First load in flight, nothing cached yet. */
export const Loading: Story = { args: { runs: [], loading: true } };

/** One family failed to load — a non-blocking warning above what did load. */
export const OneFamilyFailed: Story = {
  args: {
    runs: MIXED.filter((r) => r.family !== 'harness'),
    error: 'Couldn’t load Harness history — showing what loaded.',
  },
};

/** Every loaded run filtered out — the narrowed empty state, distinct from
 *  "no runs yet" (the history isn't empty, the filter is just too narrow). */
export const FilteredToNothing: Story = { args: { runs: [], totalRuns: 4 } };

/** A narrowed list: the footer counts what's hidden alongside the retention rule. */
export const Narrowed: Story = {
  args: { runs: MIXED.filter((r) => r.family === 'insight'), totalRuns: MIXED.length },
};

/** The retention cap not yet probed — the footer states the rule with no number. */
export const RetentionUnknown: Story = { args: { retention: null } };

/** Read-only list: no delete handler, so rows carry no delete affordance. */
export const WithoutDelete: Story = { args: { onDeleteRun: undefined } };

/** Play test: clicking a row opens the run on its family. Targets the row by its
 *  title — `/Harness/` alone would also match the row's delete button. */
export const OpensRun: Story = {
  args: { runs: [run({ id: 'h1', family: 'harness', title: '4 conventions' })] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('4 conventions'));
    await expect(args.onOpenRun).toHaveBeenCalledWith('harness', 'h1');
  },
};

/** Play test: the per-row delete reports the family + id it targets, and does NOT
 *  open the run (the two controls are siblings, never nested). */
export const DeletesRun: Story = {
  args: { runs: [run({ id: 'i9', family: 'insight', title: '2 findings' })] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete this Insight run' }));
    await expect(args.onDeleteRun).toHaveBeenCalledWith('insight', 'i9');
    await expect(args.onOpenRun).not.toHaveBeenCalled();
  },
};
