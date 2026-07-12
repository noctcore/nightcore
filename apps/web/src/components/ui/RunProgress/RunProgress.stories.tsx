import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { BookIcon, BugIcon, LayersIcon, PerfIcon, RefactorIcon, VerifiedIcon } from '../icons';
import { RunProgress } from './RunProgress';
import type { RunProgressCategory } from './RunProgress.types';

const categories: RunProgressCategory[] = [
  { key: 'architecture', label: 'Architecture', icon: LayersIcon },
  { key: 'imports', label: 'Imports & Boundaries', icon: RefactorIcon },
  { key: 'naming', label: 'Naming', icon: BookIcon },
  { key: 'structure', label: 'Folder Structure', icon: BugIcon },
  { key: 'design', label: 'Design Decisions', icon: VerifiedIcon },
  { key: 'perf', label: 'Performance', icon: PerfIcon },
];

const meta = {
  title: 'UI/RunProgress',
  component: RunProgress,
  args: {
    status: 'running',
    categories,
    categoryState: {
      architecture: 'done',
      imports: 'done',
      naming: 'running',
      structure: 'pending',
      design: 'pending',
      perf: 'pending',
    },
    findingCounts: { architecture: 8, imports: 7 },
    costUsd: 8.41,
    usage: { inputTokens: 180000, outputTokens: 34000 },
    durationMs: 372000,
    onOpenCategory: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 820, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mid-run: two lenses done, one scanning, three queued. */
export const Running: Story = {};

/** Insight passes `unitLabel="categories"` so the count reads in its own noun. */
export const CustomUnitLabel: Story = {
  args: { unitLabel: 'categories' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/2 \/ 6 categories · 33%/)).toBeVisible();
  },
};

/** Done rows are buttons — clicking one opens that category (partial reveal). */
export const OpensDoneCategory: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Architecture/ }));
    await expect(args.onOpenCategory).toHaveBeenCalledWith('architecture');
  },
};

/** Harness synthesis phase — every lens done, synthesis row + bar shimmer. */
export const Synthesizing: Story = {
  args: {
    categoryState: {
      architecture: 'done',
      imports: 'done',
      naming: 'done',
      structure: 'done',
      design: 'done',
      perf: 'done',
    },
    findingCounts: { architecture: 8, imports: 7, naming: 3, structure: 2, design: 5, perf: 1 },
    synthesizing: true,
  },
};

/** Deep mode (issue #294): a running category shows "round N (M new)" instead of
 *  "scanning…"; a category with no round yet renders the classic text unchanged. */
export const DeepRounds: Story = {
  args: {
    categoryRounds: {
      architecture: { round: 5, newFindingsThisRound: 0 },
      naming: { round: 3, newFindingsThisRound: 2 },
    },
  },
};

/** A lens that errored still renders a clickable row. */
export const WithError: Story = {
  args: {
    categoryState: {
      architecture: 'done',
      imports: 'error',
      naming: 'running',
      structure: 'pending',
      design: 'pending',
      perf: 'pending',
    },
  },
};

/** Terminal completed run — overall bar full, status reads "complete". */
export const Completed: Story = {
  args: {
    status: 'completed',
    categoryState: {
      architecture: 'done',
      imports: 'done',
      naming: 'done',
      structure: 'done',
      design: 'done',
      perf: 'done',
    },
    findingCounts: { architecture: 8, imports: 7, naming: 3, structure: 2, design: 5, perf: 1 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/6 \/ 6 lenses · 100%/)).toBeVisible();
  },
};
